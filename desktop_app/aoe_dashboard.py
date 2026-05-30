import csv
import json
import math
import os
import re
import sqlite3
import statistics
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from PySide6.QtCore import QAbstractTableModel, QModelIndex, QObject, QProcess, QProcessEnvironment, Qt, QTimer, Signal
from PySide6.QtGui import QAction, QColor, QFont, QPainter, QPen
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QFileDialog,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QLayout,
    QMainWindow,
    QMenu,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSpinBox,
    QTableView,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)


APP_NAME = "AOE Dashboard"
BEIJING_TZ = timezone(timedelta(hours=8))
if getattr(sys, "frozen", False):
    _exe_dir = Path(sys.executable).resolve().parent
    ROOT_DIR = _exe_dir.parent if (_exe_dir.parent / "scripts").exists() else _exe_dir
else:
    ROOT_DIR = Path(__file__).resolve().parents[1]
DB_PATH = ROOT_DIR / "runtime-state" / "trades.db"
VOLUME_HISTORY_DB_PATH = ROOT_DIR / "runtime-state" / "volume_history.db"


def now_iso() -> str:
    return datetime.now().isoformat(timespec="milliseconds")


def fmt_money(value: float) -> str:
    return f"${value:,.2f}"


def fmt_num(value: float) -> str:
    return f"{value:,.2f}"


def fmt_millions(value: float) -> str:
    if abs(value) >= 1_000_000_000:
        return f"{value / 1_000_000_000:.2f}B"
    if abs(value) >= 1_000_000:
        return f"{value / 1_000_000:.0f}M"
    if abs(value) >= 1_000:
        return f"{value / 1_000:.1f}K"
    return f"{value:.0f}"


def fmt_turnover(value: float) -> str:
    if abs(value) >= 100_000_000:
        return f"{value / 100_000_000:.2f}亿"
    if abs(value) >= 10_000:
        return f"{value / 10_000:.2f}万"
    return f"{value:.0f}"


def fmt_predictor_volume(value: float) -> str:
    if abs(value) >= 1_000_000_000:
        return f"{value / 1_000_000_000:.2f}B"
    return f"{value / 1_000_000:.1f}M"


def fmt_duration(seconds: int) -> str:
    seconds = max(0, int(seconds))
    hours, remainder = divmod(seconds, 3600)
    minutes = remainder // 60
    return f"{hours}h {minutes:02d}m"


def load_env(path: Path):
    values = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("\"'")
    return values


def env_bool(values, key, default=False):
    raw = values.get(key)
    if raw is None:
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


class Store:
    def __init__(self, db_path: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row
        self.init_schema()
        self.cleanup_legacy_demo_rows()
        self.rebuild_daily_stats()

    def init_schema(self):
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS executions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ts TEXT NOT NULL,
              pair TEXT NOT NULL DEFAULT 'BNB/USDT',
              side TEXT NOT NULL DEFAULT 'BUY',
              amount_usdt REAL NOT NULL DEFAULT 0,
              price REAL NOT NULL DEFAULT 0,
              gas_usdt REAL NOT NULL DEFAULT 0,
              status TEXT NOT NULL DEFAULT 'pending',
              tx_hash TEXT,
              duration_ms INTEGER NOT NULL DEFAULT 0,
              source TEXT NOT NULL DEFAULT 'aoe',
              error TEXT
            );
            CREATE TABLE IF NOT EXISTS market_snapshots (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ts TEXT NOT NULL,
              pair TEXT NOT NULL,
              price REAL NOT NULL,
              change_5m REAL NOT NULL,
              change_15m REAL NOT NULL,
              change_1h REAL NOT NULL,
              change_24h REAL NOT NULL,
              volume_24h REAL NOT NULL,
              bid_volume REAL NOT NULL,
              ask_volume REAL NOT NULL,
              spread REAL NOT NULL,
              status TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS daily_stats (
              day TEXT PRIMARY KEY,
              turnover_usdt REAL NOT NULL DEFAULT 0,
              trade_count INTEGER NOT NULL DEFAULT 0,
              gas_usdt REAL NOT NULL DEFAULT 0,
              net_invested_usdt REAL NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS gas_stats (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ts TEXT NOT NULL,
              gas_price_gwei REAL NOT NULL,
              gas_used INTEGER NOT NULL,
              gas_usdt REAL NOT NULL,
              network_status TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS execution_metrics (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              execution_id INTEGER,
              ts TEXT NOT NULL,
              pair TEXT NOT NULL DEFAULT 'BNB/USDT',
              quote_rtt_ms INTEGER,
              rpc_rtt_ms INTEGER,
              signature_ms INTEGER,
              broadcast_ms INTEGER,
              confirmation_ms INTEGER,
              total_ms INTEGER,
              gas_usdt REAL,
              block_height INTEGER,
              current_gas_gwei REAL,
              priority_fee_gwei REAL,
              base_fee_gwei REAL,
              target_gas_usdt REAL,
              failure_reason TEXT
            );
            CREATE TABLE IF NOT EXISTS network_metrics (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ts TEXT NOT NULL,
              source TEXT NOT NULL,
              status TEXT NOT NULL,
              latency_ms INTEGER,
              error_count INTEGER NOT NULL DEFAULT 0,
              last_error TEXT
            );
            CREATE TABLE IF NOT EXISTS wallet_snapshots (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ts TEXT NOT NULL,
              wallet_address TEXT,
              account_balance REAL DEFAULT 0,
              available_balance REAL DEFAULT 0,
              wallet_nav_usdt REAL DEFAULT 0,
              usdt_balance REAL DEFAULT 0,
              bnb_balance REAL DEFAULT 0,
              token_42_balance REAL DEFAULT 0,
              health_score INTEGER DEFAULT 100
            );
            CREATE TABLE IF NOT EXISTS daily_statistics (
              day TEXT PRIMARY KEY,
              pair TEXT NOT NULL DEFAULT 'ALL',
              turnover_usdt REAL NOT NULL DEFAULT 0,
              trade_count INTEGER NOT NULL DEFAULT 0,
              success_count INTEGER NOT NULL DEFAULT 0,
              failed_count INTEGER NOT NULL DEFAULT 0,
              gas_usdt REAL NOT NULL DEFAULT 0,
              avg_latency_ms REAL NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS volume_predictor_logs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ts TEXT NOT NULL,
              symbol TEXT NOT NULL,
              current_volume REAL NOT NULL,
              elapsed_pct REAL NOT NULL,
              remaining_seconds INTEGER NOT NULL,
              speed_1h REAL NOT NULL,
              speed_4h REAL NOT NULL,
              speed_12h REAL NOT NULL,
              avg_speed REAL NOT NULL,
              predicted_volume REAL NOT NULL,
              lower_volume REAL NOT NULL,
              upper_volume REAL NOT NULL,
              current_range TEXT NOT NULL,
              predicted_range TEXT NOT NULL,
              target_range TEXT NOT NULL,
              confidence REAL NOT NULL,
              event_message TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS binance_daily_volumes (
              symbol TEXT NOT NULL,
              day TEXT NOT NULL,
              open_price REAL NOT NULL,
              close_price REAL NOT NULL,
              base_volume REAL NOT NULL,
              quote_volume REAL NOT NULL,
              change_pct REAL NOT NULL,
              complete INTEGER NOT NULL DEFAULT 0,
              fetched_at TEXT NOT NULL,
              PRIMARY KEY (symbol, day)
            );
            CREATE TABLE IF NOT EXISTS auto_buy_runs (
              scan_day TEXT PRIMARY KEY,
              market_address TEXT NOT NULL,
              token_id INTEGER NOT NULL,
              amount_usdt REAL NOT NULL,
              status TEXT NOT NULL,
              started_at TEXT NOT NULL,
              finished_at TEXT
            );
            CREATE TABLE IF NOT EXISTS app_settings (
              setting_key TEXT PRIMARY KEY,
              setting_value TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_executions_ts ON executions(ts DESC);
            CREATE INDEX IF NOT EXISTS idx_market_pair_ts ON market_snapshots(pair, ts DESC);
            CREATE INDEX IF NOT EXISTS idx_execution_metrics_ts ON execution_metrics(ts DESC);
            CREATE INDEX IF NOT EXISTS idx_network_metrics_source_ts ON network_metrics(source, ts DESC);
            CREATE INDEX IF NOT EXISTS idx_volume_predictor_ts ON volume_predictor_logs(ts DESC);
            CREATE INDEX IF NOT EXISTS idx_binance_daily_volume_day ON binance_daily_volumes(symbol, day DESC);
            """
        )
        self.ensure_columns("executions", {
            "signature_ms": "INTEGER DEFAULT 0",
            "broadcast_ms": "INTEGER DEFAULT 0",
            "confirmation_ms": "INTEGER DEFAULT 0",
            "total_ms": "INTEGER DEFAULT 0",
            "profit_usdt": "REAL DEFAULT 0",
        })
        self.ensure_columns("wallet_snapshots", {
            "token_42_balance": "REAL DEFAULT 0",
        })
        self.conn.commit()

    def ensure_columns(self, table, columns):
        existing = {row["name"] for row in self.conn.execute(f"PRAGMA table_info({table})").fetchall()}
        for name, ddl in columns.items():
            if name not in existing:
                self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")

    def cleanup_legacy_demo_rows(self):
        self.conn.execute(
            """
            DELETE FROM executions
            WHERE source IN ('aoe-scheduler', 'manual')
              AND (
                tx_hash GLOB '0x[0-9][0-9]0000000000000000000000000000000000000000000000000000000000'
                OR tx_hash GLOB '0x[0-9][0-9]1111111111111111111111111111111111111111111111111111111111'
                OR tx_hash GLOB '0x[0-9][0-9]2222222222222222222222222222222222222222222222222222222222'
              )
            """
        )
        self.conn.commit()

    def rebuild_daily_stats(self):
        self.conn.executescript(
            """
            DELETE FROM daily_stats;
            INSERT INTO daily_stats(day, turnover_usdt, trade_count, gas_usdt, net_invested_usdt)
            SELECT
              substr(ts, 1, 10),
              COALESCE(SUM(amount_usdt), 0),
              COUNT(*),
              COALESCE(SUM(gas_usdt), 0),
              COALESCE(SUM(CASE WHEN side = 'BUY' THEN amount_usdt ELSE -amount_usdt END), 0)
            FROM executions
            WHERE status IN ('success', 'confirmed')
            GROUP BY substr(ts, 1, 10);
            """
        )
        self.conn.executescript(
            """
            DELETE FROM daily_statistics;
            INSERT OR REPLACE INTO daily_statistics
              (day, pair, turnover_usdt, trade_count, success_count, failed_count, gas_usdt, avg_latency_ms)
            SELECT
              substr(ts, 1, 10),
              pair,
              COALESCE(SUM(CASE WHEN status IN ('success','confirmed') THEN amount_usdt ELSE 0 END), 0),
              COUNT(*),
              SUM(CASE WHEN status IN ('success','confirmed') THEN 1 ELSE 0 END),
              SUM(CASE WHEN status NOT IN ('success','confirmed') THEN 1 ELSE 0 END),
              COALESCE(SUM(gas_usdt), 0),
              COALESCE(AVG(duration_ms), 0)
            FROM executions
            GROUP BY substr(ts, 1, 10), pair;
            """
        )
        self.conn.commit()

    def kpi(self):
        today = datetime.now().strftime("%Y-%m-%d")
        hour_ago = (datetime.now() - timedelta(hours=1)).isoformat()
        day_ago = (datetime.now() - timedelta(hours=24)).isoformat()
        days_7 = (datetime.now() - timedelta(days=7)).isoformat()
        days_30 = (datetime.now() - timedelta(days=30)).isoformat()
        week_start = (datetime.now() - timedelta(days=datetime.now().weekday())).strftime("%Y-%m-%d")
        month = datetime.now().strftime("%Y-%m")
        today_row = self.conn.execute(
            """
            SELECT
              COUNT(*) trades,
              COALESCE(SUM(amount_usdt),0) turnover,
              COALESCE(SUM(gas_usdt),0) gas,
              SUM(CASE WHEN status IN ('success','confirmed') THEN 1 ELSE 0 END) success_count,
              SUM(CASE WHEN status NOT IN ('success','confirmed') THEN 1 ELSE 0 END) failed_count,
              COALESCE(AVG(duration_ms),0) avg_delay,
              COALESCE(MIN(duration_ms),0) fastest_ms,
              COALESCE(MAX(duration_ms),0) slowest_ms
            FROM executions WHERE substr(ts,1,10)=?
            """,
            (today,),
        ).fetchone()
        week_row = self.conn.execute(
            "SELECT COALESCE(SUM(amount_usdt),0) turnover FROM executions WHERE substr(ts,1,10)>=?",
            (week_start,),
        ).fetchone()
        month_row = self.conn.execute(
            """
            SELECT COUNT(*) trades, COALESCE(SUM(amount_usdt),0) turnover
            FROM executions WHERE substr(ts,1,7)=?
            """,
            (month,),
        ).fetchone()
        rates = self.conn.execute(
            """
            SELECT
              AVG(CASE WHEN status IN ('success','confirmed') THEN 1.0 ELSE 0.0 END) success_rate,
              AVG(CASE WHEN status NOT IN ('success','confirmed') THEN 1.0 ELSE 0.0 END) failure_rate
            FROM executions WHERE ts >= ?
            """,
            ((datetime.now() - timedelta(days=30)).isoformat(),),
        ).fetchone()
        windows = {}
        for key, since in {
            "hour_turnover": hour_ago,
            "day_turnover": day_ago,
            "days_7_turnover": days_7,
            "days_30_turnover": days_30,
        }.items():
            windows[key] = self.conn.execute(
                "SELECT COALESCE(SUM(amount_usdt),0) value FROM executions WHERE ts >= ? AND status IN ('success','confirmed')",
                (since,),
            ).fetchone()["value"]
        wallet = self.latest_wallet_snapshot()
        return {
            "bnb_balance": wallet["bnb_balance"],
            "usdt_balance": wallet["usdt_balance"],
            "token_42_balance": wallet["token_42_balance"],
            "today_turnover": today_row["turnover"],
            "today_trades": today_row["trades"],
            "today_success": today_row["success_count"] or 0,
            "today_failed": today_row["failed_count"] or 0,
            "today_gas": today_row["gas"],
            "today_avg_delay": today_row["avg_delay"],
            "fastest_ms": today_row["fastest_ms"],
            "slowest_ms": today_row["slowest_ms"],
            "week_turnover": week_row["turnover"],
            "month_turnover": month_row["turnover"],
            "month_trades": month_row["trades"],
            "success_rate": (rates["success_rate"] or 0) * 100,
            "failure_rate": (rates["failure_rate"] or 0) * 100,
            "consecutive_failures": self.consecutive_failures(),
            **windows,
            "updated_at": datetime.now().strftime("%H:%M:%S"),
        }

    def latest_wallet_snapshot(self):
        row = self.conn.execute("SELECT * FROM wallet_snapshots ORDER BY ts DESC LIMIT 1").fetchone()
        if row:
            return row
        return {
            "wallet_nav_usdt": 0,
            "usdt_balance": 0,
            "bnb_balance": 0,
            "token_42_balance": 0,
            "account_balance": 0,
            "available_balance": 0,
            "health_score": 0,
        }

    def consecutive_failures(self):
        rows = self.conn.execute("SELECT status FROM executions ORDER BY ts DESC LIMIT 50").fetchall()
        count = 0
        for row in rows:
            if row["status"] in {"success", "confirmed"}:
                break
            count += 1
        return count

    def daily_rows(self, days=30):
        since = (datetime.now() - timedelta(days=days - 1)).strftime("%Y-%m-%d")
        return self.conn.execute(
            """
            SELECT day, turnover_usdt, trade_count, gas_usdt, net_invested_usdt
            FROM daily_stats WHERE day >= ? ORDER BY day ASC
            """,
            (since,),
        ).fetchall()

    def strategy_rows(self):
        since = (datetime.now() - timedelta(days=30)).isoformat()
        rows = self.conn.execute(
            """
            SELECT pair,
                   COUNT(*) trades,
                   COALESCE(SUM(amount_usdt),0) turnover,
                   COALESCE(AVG(amount_usdt),0) avg_amount,
                   COALESCE(SUM(gas_usdt),0) gas,
                   AVG(CASE WHEN status IN ('success','confirmed') THEN 1.0 ELSE 0.0 END) * 100 success_rate,
                   AVG(CASE WHEN status NOT IN ('success','confirmed') THEN 1.0 ELSE 0.0 END) * 100 failure_rate,
                   COALESCE(AVG(duration_ms),0) avg_delay_ms,
                   COALESCE(MIN(duration_ms),0) fastest_ms,
                   COALESCE(MAX(duration_ms),0) slowest_ms
            FROM executions
            WHERE pair IN ('BNB/USDT','BTC/USDT','SOL/USDT','ETH/USDT') AND ts >= ?
            GROUP BY pair
            ORDER BY CASE pair WHEN 'BNB/USDT' THEN 0 WHEN 'BTC/USDT' THEN 1 WHEN 'SOL/USDT' THEN 2 ELSE 3 END
            """,
            (since,),
        ).fetchall()
        by_pair = {row["pair"]: dict(row) for row in rows}
        result = []
        for pair in ["BNB/USDT", "BTC/USDT", "SOL/USDT", "ETH/USDT"]:
            result.append(
                by_pair.get(
                    pair,
                    {
                        "pair": pair,
                        "trades": 0,
                        "turnover": 0,
                        "avg_amount": 0,
                        "gas": 0,
                        "success_rate": 0,
                        "failure_rate": 0,
                        "avg_delay_ms": 0,
                        "fastest_ms": 0,
                        "slowest_ms": 0,
                    },
                )
            )
        return result

    def latest_market_rows(self):
        return self.conn.execute(
            """
            SELECT m.*
            FROM market_snapshots m
            JOIN (
              SELECT pair, MAX(ts) ts
              FROM market_snapshots
              GROUP BY pair
            ) latest ON latest.pair = m.pair AND latest.ts = m.ts
            ORDER BY CASE m.pair WHEN 'BNB/USDT' THEN 0 WHEN 'BTC/USDT' THEN 1 WHEN 'SOL/USDT' THEN 2 WHEN 'ETH/USDT' THEN 3 ELSE 4 END
            """
        ).fetchall()

    def market_quality(self):
        rows = self.conn.execute(
            """
            SELECT e.pair,
                   AVG(CASE WHEN e.status IN ('success','confirmed') THEN 1.0 ELSE 0.0 END) * 100 success_rate,
                   COALESCE(AVG(e.gas_usdt),0) avg_gas,
                   COALESCE(AVG(COALESCE(m.broadcast_ms, e.broadcast_ms, 0)),0) avg_submit_ms,
                   COALESCE(AVG(m.quote_rtt_ms),0) quote_rtt_ms,
                   COALESCE(AVG(m.rpc_rtt_ms),0) rpc_delay_ms
            FROM executions e
            LEFT JOIN execution_metrics m ON m.execution_id = e.id
            WHERE e.ts >= ?
            GROUP BY e.pair
            """,
            ((datetime.now() - timedelta(days=30)).isoformat(),),
        ).fetchall()
        return {row["pair"]: row for row in rows}

    def latest_execution_metrics(self):
        metric = self.conn.execute("SELECT * FROM execution_metrics ORDER BY ts DESC LIMIT 1").fetchone()
        execution = self.conn.execute("SELECT * FROM executions ORDER BY ts DESC LIMIT 1").fetchone()
        return metric, execution

    def connection_statuses(self):
        defaults = ["42 API", "\u5e01\u5b89\u671f\u8d27API", "\u5e01\u5b89\u671f\u8d27\u65e5\u7ebf", "\u9884\u6d4b\u5668", "RPC节点", "\u94b1\u5305", "SQLite", "\u65e5\u5fd7\u7cfb\u7edf"]
        result = {}
        for source in defaults:
            row = self.conn.execute(
                "SELECT * FROM network_metrics WHERE source=? ORDER BY ts DESC LIMIT 1",
                (source,),
            ).fetchone()
            if row:
                result[source] = row
            else:
                result[source] = {
                    "source": source,
                    "status": "\u5728\u7ebf" if source in {"SQLite", "\u65e5\u5fd7\u7cfb\u7edf"} else "\u79bb\u7ebf",
                    "latency_ms": 0,
                    "error_count": 0,
                    "ts": "-",
                    "last_error": "",
                }
        return result

    def record_network_metric(self, source, status, latency_ms=0, error_count=0, last_error=""):
        self.conn.execute(
            """
            INSERT INTO network_metrics(source, status, latency_ms, error_count, ts, last_error)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (source, status, int(latency_ms or 0), int(error_count or 0), now_iso(), last_error),
        )
        self.conn.commit()

    def chart_series(self, days):
        since = (datetime.now() - timedelta(days=days - 1)).strftime("%Y-%m-%d")
        return self.conn.execute(
            """
            SELECT day,
                   SUM(turnover_usdt) turnover,
                   SUM(trade_count) trades,
                   SUM(gas_usdt) gas,
                   CASE WHEN SUM(trade_count) > 0 THEN SUM(success_count) * 100.0 / SUM(trade_count) ELSE 0 END success_rate
            FROM daily_statistics
            WHERE day >= ?
            GROUP BY day
            ORDER BY day ASC
            """,
            (since,),
        ).fetchall()

    def replace_market_snapshots(self, rows):
        ts = now_iso()
        for row in rows:
            self.conn.execute(
                """
                INSERT INTO market_snapshots
                (ts, pair, price, change_5m, change_15m, change_1h, change_24h, volume_24h, bid_volume, ask_volume, spread, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    ts,
                    row["pair"],
                    row["price"],
                    row["change_5m"],
                    row["change_15m"],
                    row["change_1h"],
                    row["change_24h"],
                    row["volume_24h"],
                    row["bid_volume"],
                    row["ask_volume"],
                    row["spread"],
                    row["status"],
                ),
            )
        self.conn.commit()

    def reserve_auto_buy_run(self, scan_day: str, market_address: str, token_id: int, amount_usdt: float) -> bool:
        try:
            self.conn.execute(
                """
                INSERT INTO auto_buy_runs(scan_day, market_address, token_id, amount_usdt, status, started_at)
                VALUES (?, ?, ?, ?, 'started', ?)
                """,
                (scan_day, market_address, token_id, amount_usdt, now_iso()),
            )
            self.conn.commit()
            return True
        except sqlite3.IntegrityError:
            return False

    def finish_auto_buy_run(self, scan_day: str, status: str):
        self.conn.execute(
            "UPDATE auto_buy_runs SET status = ?, finished_at = ? WHERE scan_day = ?",
            (status, now_iso(), scan_day),
        )
        self.conn.commit()

    def setting(self, key: str, default: str = "") -> str:
        row = self.conn.execute(
            "SELECT setting_value FROM app_settings WHERE setting_key = ?",
            (key,),
        ).fetchone()
        return row["setting_value"] if row else default

    def set_setting(self, key: str, value: str):
        self.conn.execute(
            """
            INSERT INTO app_settings(setting_key, setting_value) VALUES (?, ?)
            ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value
            """,
            (key, value),
        )
        self.conn.commit()

    def record_volume_prediction(self, result):
        previous = self.conn.execute(
            "SELECT * FROM volume_predictor_logs WHERE symbol=? ORDER BY ts DESC LIMIT 1",
            (result["symbol"],),
        ).fetchone()
        events = []
        if previous:
            change = result["current_volume"] - previous["current_volume"]
            if abs(change) >= 1:
                events.append(f"成交额 {fmt_predictor_volume(previous['current_volume'])} -> {fmt_predictor_volume(result['current_volume'])}")
            if previous["predicted_range"] != result["predicted_range"]:
                events.append(f"预测区间 {previous['predicted_range']} -> {result['predicted_range']}")
            if abs(result["predicted_volume"] - previous["predicted_volume"]) >= 1_000_000:
                events.append(f"预测 {fmt_predictor_volume(previous['predicted_volume'])} -> {fmt_predictor_volume(result['predicted_volume'])}")
        else:
            events.append(f"开始预测 {result['predicted_range']}")
        message = "；".join(events) or "预测刷新"
        self.conn.execute(
            """
            INSERT INTO volume_predictor_logs
            (ts, symbol, current_volume, elapsed_pct, remaining_seconds, speed_1h, speed_4h, speed_12h,
             avg_speed, predicted_volume, lower_volume, upper_volume, current_range, predicted_range,
             target_range, confidence, event_message)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                now_iso(), result["symbol"], result["current_volume"], result["elapsed_pct"],
                result["remaining_seconds"], result["speed_1h"], result["speed_4h"],
                result["speed_12h"], result["avg_speed"], result["predicted_volume"],
                result["lower_volume"], result["upper_volume"], result["current_range"],
                result["predicted_range"], result["target_range"], result["confidence"], message,
            ),
        )
        self.conn.commit()
        return message

    def replace_binance_daily_volumes(self, rows):
        for row in rows:
            self.conn.execute(
                """
                INSERT OR REPLACE INTO binance_daily_volumes
                (symbol, day, open_price, close_price, base_volume, quote_volume, change_pct, complete, fetched_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row["symbol"], row["day"], row["open_price"], row["close_price"],
                    row["base_volume"], row["quote_volume"], row["change_pct"],
                    1 if row["complete"] else 0, now_iso(),
                ),
            )
        self.conn.commit()

    def binance_daily_volume_rows(self, symbols, days):
        placeholders = ",".join("?" for _ in symbols)
        return self.conn.execute(
            f"""
            SELECT day, symbol, open_price, close_price, base_volume, quote_volume, change_pct, complete
            FROM binance_daily_volumes
            WHERE symbol IN ({placeholders})
              AND day IN (
                SELECT day FROM binance_daily_volumes
                WHERE symbol IN ({placeholders})
                GROUP BY day
                ORDER BY day DESC
                LIMIT ?
              )
            ORDER BY day DESC,
              CASE symbol WHEN 'BNBUSDT' THEN 0 WHEN 'BTCUSDT' THEN 1 WHEN 'SOLUSDT' THEN 2 WHEN 'ETHUSDT' THEN 3 ELSE 4 END
            """,
            (*symbols, *symbols, days),
        ).fetchall()


class MarketDataClient:
    FUTURES_API_BASE = "https://fapi.binance.com/fapi/v1"
    SYMBOLS = {
        "BNB/USDT": "BNBUSDT",
        "BTC/USDT": "BTCUSDT",
        "SOL/USDT": "SOLUSDT",
        "ETH/USDT": "ETHUSDT",
    }

    def fetch(self):
        rows = []
        for pair, symbol in self.SYMBOLS.items():
            ticker = self.get_json(f"{self.FUTURES_API_BASE}/ticker/24hr?symbol={symbol}")
            changes = {
                "change_5m": self.interval_change(symbol, "5m"),
                "change_15m": self.interval_change(symbol, "15m"),
                "change_1h": self.interval_change(symbol, "1h"),
            }
            bid = float(ticker.get("bidQty") or 0)
            ask = float(ticker.get("askQty") or 0)
            bid_price = float(ticker.get("bidPrice") or 0)
            ask_price = float(ticker.get("askPrice") or 0)
            rows.append(
                {
                    "pair": pair,
                    "price": float(ticker["lastPrice"]),
                    "change_5m": changes["change_5m"],
                    "change_15m": changes["change_15m"],
                    "change_1h": changes["change_1h"],
                    "change_24h": float(ticker["priceChangePercent"]),
                    # Market monitor matches Binance Futures 24h Vol(USDT).
                    "volume_24h": float(ticker["quoteVolume"]),
                    "bid_volume": bid * bid_price,
                    "ask_volume": ask * ask_price,
                    "spread": max(0.0, ask_price - bid_price),
                    "status": "\u5728\u7ebf",
                }
            )
        return rows

    def interval_change(self, symbol: str, interval: str) -> float:
        rows = self.get_json(f"{self.FUTURES_API_BASE}/klines?symbol={symbol}&interval={interval}&limit=1")
        if not rows:
            return 0.0
        return self.candle_change(rows[-1])

    @staticmethod
    def candle_change(row) -> float:
        open_price = float(row[1])
        close_price = float(row[4])
        if open_price == 0:
            return 0.0
        return ((close_price - open_price) / open_price) * 100

    def get_json(self, url: str):
        request = urllib.request.Request(url, headers={"User-Agent": "AOE-Dashboard/1.0"})
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))


class BinanceDailyVolumeClient:
    API_BASE = "https://fapi.binance.com/fapi/v1"

    def __init__(self, symbols=None):
        self.symbols = symbols or ["BNBUSDT", "BTCUSDT", "SOLUSDT", "ETHUSDT"]

    def fetch(self, days=90):
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        rows = []
        for symbol in self.symbols:
            raw_rows = self.get_json(f"{self.API_BASE}/klines?symbol={symbol}&interval=1d&limit={days}")
            for row in raw_rows:
                day = datetime.fromtimestamp(row[0] / 1000, timezone.utc).strftime("%Y-%m-%d")
                open_price = float(row[1])
                close_price = float(row[4])
                rows.append(
                    {
                        "symbol": symbol,
                        "day": day,
                        "open_price": open_price,
                        "close_price": close_price,
                        "base_volume": float(row[5]),
                        "quote_volume": float(row[7]),
                        "change_pct": ((close_price - open_price) / open_price * 100) if open_price else 0.0,
                        "complete": day != today,
                    }
                )
        return rows

    def get_json(self, url: str):
        request = urllib.request.Request(url, headers={"User-Agent": "AOE-Dashboard/1.0"})
        with urllib.request.urlopen(request, timeout=12) as response:
            return json.loads(response.read().decode("utf-8"))


class VolumeHistoryRepository:
    def __init__(self, db_path: Path, symbol="BNBUSDT"):
        self.db_path = db_path
        self.symbol = symbol

    def connect(self):
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS volume_history (
              date TEXT PRIMARY KEY,
              volume_usdt REAL NOT NULL,
              day_of_week INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS volume_predictions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ts TEXT NOT NULL,
              market_address TEXT,
              current_volume REAL NOT NULL,
              predicted_volume REAL NOT NULL,
              lower_volume REAL NOT NULL,
              upper_volume REAL NOT NULL,
              predicted_range TEXT NOT NULL,
              confidence REAL NOT NULL,
              selected_token_id INTEGER,
              selected_price REAL,
              decision TEXT NOT NULL,
              reason TEXT
            );
            CREATE TABLE IF NOT EXISTS prediction_accuracy (
              date TEXT PRIMARY KEY,
              predicted_volume REAL NOT NULL,
              final_volume REAL,
              predicted_range TEXT NOT NULL,
              final_range TEXT,
              absolute_error REAL,
              range_correct INTEGER,
              evaluated_at TEXT
            );
            """
        )
        return conn

    def replace_history(self, rows):
        with self.connect() as conn:
            for row in rows:
                if not row["complete"] or row["symbol"] != self.symbol:
                    continue
                day = datetime.strptime(row["day"], "%Y-%m-%d").date()
                conn.execute(
                    "INSERT OR REPLACE INTO volume_history(date, volume_usdt, day_of_week) VALUES (?, ?, ?)",
                    (row["day"], row["quote_volume"], day.weekday()),
                )

    def statistics(self):
        with self.connect() as conn:
            rows = conn.execute("SELECT volume_usdt FROM volume_history ORDER BY date DESC LIMIT 30").fetchall()
        values = [float(row["volume_usdt"]) for row in rows]
        recent_7 = values[:7]
        recent_30 = values[:30]
        recent_3 = values[:3]
        def mean(data):
            return statistics.mean(data) if data else 0.0
        def median(data):
            return statistics.median(data) if data else 0.0
        return {
            "history_count": len(values),
            "avg_7d": mean(recent_7),
            "avg_30d": mean(recent_30),
            "median_7d": median(recent_7),
            "median_30d": median(recent_30),
            "stddev_30d": statistics.pstdev(recent_30) if len(recent_30) > 1 else 0.0,
            "max_30d": max(recent_30) if recent_30 else 0.0,
            "min_30d": min(recent_30) if recent_30 else 0.0,
            "avg_3d": mean(recent_3),
        }

    def record_prediction(self, result, decision, reason=""):
        selected = result.get("selected_range") or {}
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO volume_predictions
                (ts, market_address, current_volume, predicted_volume, lower_volume, upper_volume,
                 predicted_range, confidence, selected_token_id, selected_price, decision, reason)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    now_iso(), result.get("market_address", ""), result["current_volume"],
                    result["predicted_volume"], result["lower_volume"], result["upper_volume"],
                    result["predicted_range"], result["confidence"], selected.get("token_id"),
                    selected.get("price"), decision, reason,
                ),
            )


class DailyVolumePredictorClient:
    FUTURES_API_BASE = "https://fapi.binance.com/fapi/v1"

    def __init__(self, root_dir: Path, pair=None):
        env = load_env(root_dir / ".env")
        self.graphql_url = env.get("GRAPHQL_URL", "https://ft.42.space/v1/graphql")
        self.market_address = env.get("MARKET_ADDRESS", "")
        self.pair = pair or env.get("AOE_PAIR", "BNB/USDT")
        self.symbol = self.pair.replace("/", "")
        self.target_token_id = int(env.get("TARGET_TOKEN_ID", "4"))
        self.opening_snipe_mode = env_bool(env, "OPENING_SNIPE_MODE", True)
        self.opening_snipe_window_minutes = max(0, int(env.get("OPENING_SNIPE_WINDOW_MINUTES", "30")))
        history_db = VOLUME_HISTORY_DB_PATH if self.symbol == "BNBUSDT" else VOLUME_HISTORY_DB_PATH.with_name(f"volume_history_{self.symbol.lower()}.db")
        self.history = VolumeHistoryRepository(history_db, self.symbol)

    def fetch(self, market=None):
        now = datetime.now(timezone.utc)
        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        elapsed_seconds = max(1, int((now - day_start).total_seconds()))
        remaining_seconds = max(0, 86400 - elapsed_seconds)
        opening_snipe_active = self.opening_snipe_mode and elapsed_seconds < self.opening_snipe_window_minutes * 60
        historical_rows = BinanceDailyVolumeClient([self.symbol]).fetch(31)
        self.history.replace_history(historical_rows)
        history_stats = self.history.statistics()
        daily = self.get_json(
            f"{self.FUTURES_API_BASE}/klines?symbol={self.symbol}&interval=1d&limit=1"
        )[-1]
        current_volume = float(daily[7])
        recent_start = max(day_start, now - timedelta(hours=12))
        recent = self.get_json(
            f"{self.FUTURES_API_BASE}/klines?symbol={self.symbol}&interval=5m"
            f"&startTime={int(recent_start.timestamp() * 1000)}&limit=150"
        )
        speed_1h = self.window_speed(recent, now, day_start, 1)
        speed_4h = self.window_speed(recent, now, day_start, 4)
        speed_12h = self.window_speed(recent, now, day_start, 12)
        speed_15m = self.window_speed(recent, now, day_start, 0.25)
        avg_speed = current_volume / (elapsed_seconds / 3600)
        history_speed = self.historical_same_period_speed(now, day_start, elapsed_seconds)
        weighted_speed = (speed_1h * 0.5) + (speed_4h * 0.3) + (avg_speed * 0.2)
        remaining_hours = remaining_seconds / 3600
        predicted_volume = current_volume + (weighted_speed * remaining_hours)
        reference_speeds = [speed_1h, speed_4h, speed_12h, avg_speed]
        if history_speed > 0:
            reference_speeds.append(history_speed)
        lower_volume = current_volume + (min(reference_speeds) * remaining_hours)
        upper_volume = current_volume + (max(reference_speeds) * remaining_hours)
        prediction_mode = "Opening Snipe" if opening_snipe_active else "Normal Predictor"
        if opening_snipe_active:
            historical_inputs = [
                history_stats["avg_7d"],
                history_stats["avg_30d"],
                history_stats["avg_3d"],
            ]
            if any(value > 0 for value in historical_inputs):
                predicted_volume = (
                    (history_stats["avg_7d"] * 0.5)
                    + (history_stats["avg_30d"] * 0.3)
                    + (history_stats["avg_3d"] * 0.2)
                )
                nonzero_inputs = [value for value in historical_inputs if value > 0]
                lower_volume = min(nonzero_inputs)
                upper_volume = max(nonzero_inputs)
        market = market or self.get_market()
        ranges = self.parse_ranges(market.get("outcomes") or [])
        current_range = self.range_for(current_volume, ranges)
        predicted_range = self.range_for(predicted_volume, ranges)
        target_range = predicted_range
        confidence = self.range_confidence(predicted_range, lower_volume, upper_volume, ranges)
        selected_range = next((item for item in ranges if item["label"] == predicted_range), None)
        close_at = day_start + timedelta(hours=12)
        close_remaining = max(0, int((close_at - now).total_seconds()))
        status = "SMART 预测目标区间"
        return {
            "symbol": self.symbol,
            "title": market.get("title") or self.pair,
            "market_address": market.get("market_address") or self.market_address,
            "current_volume": current_volume,
            "elapsed_pct": elapsed_seconds * 100 / 86400,
            "remaining_seconds": remaining_seconds,
            "speed_1h": speed_1h,
            "speed_4h": speed_4h,
            "speed_12h": speed_12h,
            "speed_15m": speed_15m,
            "avg_speed": avg_speed,
            "history_speed": history_speed,
            "predicted_volume": predicted_volume,
            "lower_volume": lower_volume,
            "upper_volume": upper_volume,
            "current_range": current_range,
            "predicted_range": predicted_range,
            "target_range": target_range,
            "confidence": confidence,
            "deviation": predicted_volume - current_volume,
            "close_remaining": close_remaining,
            "close_at": close_at.strftime("%H:%M UTC / 20:00 北京"),
            "status": "Opening Snipe Mode Active" if opening_snipe_active else status,
            "prediction_mode": prediction_mode,
            "opening_snipe_active": opening_snipe_active,
            "opening_snipe_window_minutes": self.opening_snipe_window_minutes,
            "ranges": ranges,
            "selected_range": selected_range,
            **history_stats,
        }

    @staticmethod
    def window_speed(rows, now, day_start, hours):
        cutoff = max(day_start, now - timedelta(hours=hours))
        volume = sum(float(row[7]) for row in rows if row[0] >= int(cutoff.timestamp() * 1000))
        duration_hours = max((now - cutoff).total_seconds() / 3600, 1 / 12)
        return volume / duration_hours

    def historical_same_period_speed(self, now, day_start, elapsed_seconds):
        comparable_hours = min(23, max(1, elapsed_seconds // 3600))
        start = day_start - timedelta(days=7)
        rows = self.get_json(
            f"{self.FUTURES_API_BASE}/klines?symbol={self.symbol}&interval=1h"
            f"&startTime={int(start.timestamp() * 1000)}&endTime={int(day_start.timestamp() * 1000) - 1}&limit=168"
        )
        by_day = {}
        for row in rows:
            stamp = datetime.fromtimestamp(row[0] / 1000, timezone.utc)
            if stamp.hour >= comparable_hours:
                continue
            by_day.setdefault(stamp.date(), 0.0)
            by_day[stamp.date()] += float(row[7])
        if not by_day:
            return 0.0
        return (sum(by_day.values()) / len(by_day)) / comparable_hours

    def get_market(self):
        query = """
        query PredictorMarket($address: String!) {
          home_market_list(where: {market_address: {_eq: $address}}, limit: 1) {
            title
            outcomes
          }
        }
        """
        payload = json.dumps({"query": query, "variables": {"address": self.market_address}}).encode("utf-8")
        request = urllib.request.Request(
            self.graphql_url,
            data=payload,
            headers={"content-type": "application/json", "User-Agent": "AOE-Dashboard/1.0"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=12) as response:
            body = json.loads(response.read().decode("utf-8"))
        markets = body.get("data", {}).get("home_market_list", [])
        if not markets:
            raise RuntimeError(f"Prediction market not found: {self.market_address}")
        return markets[0]

    @staticmethod
    def parse_ranges(outcomes):
        ranges = []
        for outcome in outcomes:
            name = str(outcome.get("symbol") or outcome.get("name") or "")
            limits = [float(number) * 1_000_000 for number in re.findall(r"([0-9]+(?:\.[0-9]+)?)\s*M", name)]
            if not limits:
                continue
            if "<" in name:
                low, high = 0.0, limits[0]
            elif ">" in name or "+" in name:
                low, high = limits[0], None
            elif len(limits) >= 2:
                low, high = limits[0], limits[1]
            elif re.search(r"\$?\s*0\s*[-–—]", name):
                low, high = 0.0, limits[0]
            else:
                continue
            label = f"{low / 1_000_000:.0f}M-{high / 1_000_000:.0f}M" if high else f"{low / 1_000_000:.0f}M+"
            ranges.append({
                "token_id": int(outcome.get("token_id") or 0),
                "low": low,
                "high": high,
                "label": label,
                "price": float(outcome.get("price_hmr") or outcome.get("price") or 0),
            })
        return sorted(ranges, key=lambda item: item["low"])

    @staticmethod
    def range_for(value, ranges):
        for item in ranges:
            if value >= item["low"] and (item["high"] is None or value < item["high"]):
                return item["label"]
        return "-"

    @staticmethod
    def range_confidence(label, lower, upper, ranges):
        item = next((candidate for candidate in ranges if candidate["label"] == label), None)
        if not item:
            return 0.0
        if upper <= lower:
            return 90.0
        high = item["high"] if item["high"] is not None else upper
        overlap = max(0.0, min(upper, high) - max(lower, item["low"]))
        return max(5.0, min(95.0, overlap * 100 / (upper - lower)))

    def get_json(self, url: str):
        request = urllib.request.Request(url, headers={"User-Agent": "AOE-Dashboard/1.0"})
        with urllib.request.urlopen(request, timeout=12) as response:
            return json.loads(response.read().decode("utf-8"))


class ContractDiscovery:
    def __init__(self, root_dir: Path):
        self.env = load_env(root_dir / ".env")
        self.graphql_url = self.env.get("GRAPHQL_URL", "https://ft.42.space/v1/graphql")
        self.current_market = self.env.get("MARKET_ADDRESS", "")
        self.target_pair = self.env.get("AOE_PAIR", "BNB/USDT")

    def discover_tomorrow(self):
        tomorrow = datetime.now() + timedelta(days=1)
        return self.discover_for_day(tomorrow.date())

    def discover_for_day(self, event_day, target_pair=None):
        target_pair = target_pair or self.target_pair
        date_value = datetime.combine(event_day, datetime.min.time())
        month_name = date_value.strftime("%B")
        day = date_value.day
        suffix = "th" if 11 <= day % 100 <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(day % 10, "th")
        title_pattern = f"%{target_pair} Futures Daily Volume, {month_name} {day}{suffix}%"
        query = """
        query DiscoverMarkets($q: String!) {
          home_market_list(where: {title: {_ilike: $q}}, limit: 20) {
            market_address
            title
            status
            outcomes
          }
        }
        """
        payload = json.dumps({"query": query, "variables": {"q": title_pattern}}).encode("utf-8")
        request = urllib.request.Request(
            self.graphql_url,
            data=payload,
            headers={"content-type": "application/json", "User-Agent": "AOE-Dashboard/1.0"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=12) as response:
            body = json.loads(response.read().decode("utf-8"))
        if body.get("errors"):
            raise RuntimeError(body["errors"][0].get("message", "GraphQL discovery failed"))
        markets = body.get("data", {}).get("home_market_list", [])
        if not markets:
            return None
        candidates = []
        for market in markets:
            title = str(market.get("title") or "")
            score = 0
            if target_pair in title:
                score += 10
            if f"{month_name} {day}{suffix}" in title:
                score += 10
            if market.get("status") == "not_started":
                score += 5
            if market.get("market_address", "").lower() != self.current_market.lower():
                score += 1
            candidates.append((score, market))
        candidates.sort(key=lambda item: item[0], reverse=True)
        return candidates[0][1]

    @staticmethod
    def find_volume_range_token(market, low_millions=300.0, high_millions=450.0):
        for outcome in (market or {}).get("outcomes") or []:
            name = str(outcome.get("symbol") or outcome.get("name") or "")
            values = [float(value) for value in re.findall(r"([0-9]+(?:\.[0-9]+)?)\s*M", name)]
            if len(values) >= 2 and values[0] == low_millions and values[1] == high_millions:
                return int(outcome.get("token_id")), name
        return None, ""


class NetworkSignals(QObject):
    market_loaded = Signal(object, float)
    market_failed = Signal(str)
    discovery_loaded = Signal(object, float)
    discovery_failed = Signal(str)
    predictor_loaded = Signal(object, float)
    predictor_failed = Signal(str)
    stats_loaded = Signal(object, float)
    stats_failed = Signal(str)
    auto_market_loaded = Signal(object, float)
    auto_market_failed = Signal(str)


class PagedTableModel(QAbstractTableModel):
    def __init__(self, store: Store, table_type: str):
        super().__init__()
        self.store = store
        self.table_type = table_type
        self.page = 1
        self.page_size = 50 if table_type == "trades" else 20
        self.search = ""
        self.sort_key = "ts" if table_type == "trades" else "pair"
        self.sort_dir = "DESC" if table_type == "trades" else "ASC"
        self.range_filter = "全部"
        self.rows = []
        self.total = 0
        self.market_cache = []
        if table_type == "trades":
            self.columns = [
                ("ts", "\u65f6\u95f4"),
                ("pair", "\u4ea4\u6613\u5bf9"),
                ("amount_usdt", "\u6210\u4ea4\u91d1\u989d"),
                ("price", "\u6210\u4ea4\u4ef7\u683c"),
                ("gas_usdt", "Gas"),
                ("signature_ms", "\u7b7e\u540d\u8017\u65f6"),
                ("broadcast_ms", "\u5e7f\u64ad\u8017\u65f6"),
                ("confirmation_ms", "\u786e\u8ba4\u8017\u65f6"),
                ("total_ms", "\u603b\u8017\u65f6"),
                ("tx_hash", "TX Hash"),
                ("status", "\u72b6\u6001"),
                ("profit_usdt", "\u6536\u76ca"),
            ]
        else:
            self.columns = [
                ("pair", "\u4ea4\u6613\u5bf9"),
                ("price", "\u6700\u65b0\u4ef7"),
                ("change_5m", "5m"),
                ("change_15m", "15m"),
                ("change_1h", "1h"),
                ("change_24h", "24H%"),
                ("volume_24h", "24H\u5408\u7ea6\u6210\u4ea4\u989d(USDT)"),
                ("bid_volume", "\u4e70\u76d8\u91cf"),
                ("ask_volume", "\u5356\u76d8\u91cf"),
                ("spread", "Spread"),
                ("quote_rtt_ms", "Quote RTT"),
                ("rpc_delay_ms", "RPC\u5ef6\u8fdf"),
                ("success_rate", "\u6210\u529f\u7387"),
                ("avg_gas", "\u5e73\u5747Gas"),
                ("avg_submit_ms", "\u5e73\u5747\u63d0\u4ea4\u8017\u65f6"),
                ("status", "\u72b6\u6001"),
            ]
        self.reload()

    def rowCount(self, parent=QModelIndex()):
        return 0 if parent.isValid() else len(self.rows)

    def columnCount(self, parent=QModelIndex()):
        return 0 if parent.isValid() else len(self.columns)

    def data(self, index, role=Qt.DisplayRole):
        if not index.isValid():
            return None
        row = self.rows[index.row()]
        key = self.columns[index.column()][0]
        value = row[key]
        if role == Qt.DisplayRole:
            if key == "ts":
                return str(value).replace("T", " ")[:19]
            if key in {"amount_usdt", "price", "gas_usdt", "volume_24h", "bid_volume", "ask_volume", "spread", "avg_gas", "profit_usdt"}:
                if key == "volume_24h":
                    return fmt_turnover(float(value))
                if key in {"bid_volume", "ask_volume"}:
                    return fmt_millions(float(value))
                return fmt_money(float(value)) if key != "spread" else f"{float(value):.4f}"
            if key.startswith("change_"):
                return f"{float(value):+.2f}%"
            if key == "duration_ms":
                return f"{int(value)}ms"
            if key in {"signature_ms", "broadcast_ms", "confirmation_ms", "total_ms", "quote_rtt_ms", "rpc_delay_ms", "avg_submit_ms"}:
                return "-" if value in (None, "") else f"{int(float(value))}ms"
            if key == "success_rate":
                return "-" if value in (None, "") else f"{float(value):.1f}%"
            if key == "tx_hash":
                return (value or "-")[:22]
            return str(value)
        if role == Qt.ForegroundRole:
            if key.startswith("change_"):
                return QColor("#23c483") if float(value) >= 0 else QColor("#ef4444")
            if key == "status":
                return QColor("#23c483") if str(value) in {"success", "confirmed", "在线", "priority"} else QColor("#ef4444")
        if role == Qt.TextAlignmentRole:
            return Qt.AlignVCenter | (Qt.AlignRight if key not in {"pair", "ts", "tx_hash", "status"} else Qt.AlignLeft)
        return None

    def headerData(self, section, orientation, role=Qt.DisplayRole):
        if role == Qt.DisplayRole and orientation == Qt.Horizontal:
            return self.columns[section][1]
        return None

    def sort(self, column, order=Qt.AscendingOrder):
        self.sort_key = self.columns[column][0]
        self.sort_dir = "ASC" if order == Qt.AscendingOrder else "DESC"
        self.reload()

    def set_page_size(self, size: int):
        self.page_size = size
        self.page = 1
        self.reload()

    def set_search(self, search: str):
        self.search = search
        self.page = 1
        self.reload()

    def set_range(self, value: str):
        self.range_filter = value
        self.page = 1
        self.reload()

    def next_page(self):
        if self.page * self.page_size < self.total:
            self.page += 1
            self.reload()

    def prev_page(self):
        if self.page > 1:
            self.page -= 1
            self.reload()

    def reload(self):
        self.beginResetModel()
        if self.table_type == "trades":
            q = f"%{self.search}%"
            since = {
                "最近24小时": datetime.now() - timedelta(hours=24),
                "最近7天": datetime.now() - timedelta(days=7),
                "最近30天": datetime.now() - timedelta(days=30),
            }.get(self.range_filter)
            where = "WHERE (pair LIKE ? OR tx_hash LIKE ? OR status LIKE ?)"
            params = [q, q, q]
            if since:
                where += " AND ts >= ?"
                params.append(since.isoformat())
            self.total = self.store.conn.execute(f"SELECT COUNT(*) FROM executions {where}", params).fetchone()[0]
            sql = f"""
                SELECT * FROM executions {where}
                ORDER BY {self.sort_key} {self.sort_dir}
                LIMIT ? OFFSET ?
            """
            self.rows = self.store.conn.execute(sql, (*params, self.page_size, (self.page - 1) * self.page_size)).fetchall()
        else:
            self.rows = self.make_market_rows()
            if self.search:
                self.rows = [row for row in self.rows if self.search.lower() in row["pair"].lower()]
            reverse = self.sort_dir == "DESC"
            self.rows.sort(key=lambda row: -1 if row.get(self.sort_key) is None else row.get(self.sort_key), reverse=reverse)
            self.total = len(self.rows)
            self.rows = self.rows[(self.page - 1) * self.page_size : self.page * self.page_size]
        self.endResetModel()

    def make_market_rows(self):
        quality = self.store.market_quality()
        rows = []
        for row in self.store.latest_market_rows():
            item = dict(row)
            q = quality.get(item["pair"])
            item["quote_rtt_ms"] = q["quote_rtt_ms"] if q else None
            item["rpc_delay_ms"] = q["rpc_delay_ms"] if q else None
            item["success_rate"] = q["success_rate"] if q else None
            item["avg_gas"] = q["avg_gas"] if q else None
            item["avg_submit_ms"] = q["avg_submit_ms"] if q else None
            rows.append(item)
        return rows


class StrategyTableModel(QAbstractTableModel):
    def __init__(self, store: Store):
        super().__init__()
        self.store = store
        self.columns = [
            ("pair", "\u4ea4\u6613\u5bf9"),
            ("trades", "\u6210\u4ea4\u6b21\u6570"),
            ("turnover", "\u6210\u4ea4\u989d"),
            ("avg_amount", "\u5e73\u5747\u4e70\u5165"),
            ("gas", "Gas"),
            ("success_rate", "\u6210\u529f\u7387"),
            ("failure_rate", "\u5931\u8d25\u7387"),
            ("avg_delay_ms", "\u5e73\u5747\u5ef6\u8fdf"),
            ("fastest_ms", "\u6700\u5feb\u6210\u4ea4"),
            ("slowest_ms", "\u6700\u6162\u6210\u4ea4"),
        ]
        self.rows = []
        self.reload()

    def rowCount(self, parent=QModelIndex()):
        return 0 if parent.isValid() else len(self.rows)

    def columnCount(self, parent=QModelIndex()):
        return 0 if parent.isValid() else len(self.columns)

    def data(self, index, role=Qt.DisplayRole):
        if not index.isValid():
            return None
        row = self.rows[index.row()]
        key = self.columns[index.column()][0]
        value = row[key]
        if role == Qt.DisplayRole:
            if key in {"turnover", "avg_amount", "gas"}:
                return fmt_money(float(value))
            if key in {"success_rate", "failure_rate"}:
                return f"{float(value or 0):.1f}%"
            if key in {"avg_delay_ms", "fastest_ms", "slowest_ms"}:
                return f"{float(value or 0):.0f}ms"
            return str(value)
        if role == Qt.ForegroundRole:
            if key == "success_rate":
                return QColor("#23c483")
            if key == "failure_rate":
                return QColor("#ef4444")
            if key == "pair" and value == "BNB/USDT":
                return QColor("#f4c430")
        if role == Qt.TextAlignmentRole:
            return Qt.AlignVCenter | (Qt.AlignLeft if key == "pair" else Qt.AlignRight)
        return None

    def headerData(self, section, orientation, role=Qt.DisplayRole):
        if role == Qt.DisplayRole and orientation == Qt.Horizontal:
            return self.columns[section][1]
        return None

    def reload(self):
        self.beginResetModel()
        self.rows = self.store.strategy_rows()
        self.endResetModel()


class DailyVolumeTableModel(QAbstractTableModel):
    def __init__(self, store: Store, symbols=None, days=30):
        super().__init__()
        self.store = store
        self.symbols = symbols or ["BNBUSDT", "SOLUSDT", "ETHUSDT"]
        self.days = days
        self.columns = [
            ("day", "日期 (UTC)"),
            ("symbol", "合约"),
            ("quote_volume", "每日成交额 (USDT)"),
            ("base_volume", "基础资产成交量"),
            ("close_price", "收盘价"),
            ("change_pct", "日涨跌"),
            ("complete", "状态"),
        ]
        self.rows = []
        self.reload()

    def rowCount(self, parent=QModelIndex()):
        return 0 if parent.isValid() else len(self.rows)

    def columnCount(self, parent=QModelIndex()):
        return 0 if parent.isValid() else len(self.columns)

    def data(self, index, role=Qt.DisplayRole):
        if not index.isValid():
            return None
        row = self.rows[index.row()]
        key = self.columns[index.column()][0]
        value = row[key]
        if role == Qt.DisplayRole:
            if key == "quote_volume":
                return fmt_turnover(float(value))
            if key == "base_volume":
                return f"{float(value):,.2f}"
            if key == "close_price":
                return f"{float(value):,.2f}"
            if key == "change_pct":
                return f"{float(value):+.2f}%"
            if key == "complete":
                return "已收盘" if value else "进行中"
            return str(value)
        if role == Qt.ForegroundRole:
            if key == "change_pct":
                return QColor("#23c483") if float(value) >= 0 else QColor("#ef4444")
            if key == "complete" and not value:
                return QColor("#f59e0b")
        if role == Qt.TextAlignmentRole:
            return Qt.AlignVCenter | (Qt.AlignLeft if key in {"day", "symbol", "complete"} else Qt.AlignRight)
        return None

    def headerData(self, section, orientation, role=Qt.DisplayRole):
        if role == Qt.DisplayRole and orientation == Qt.Horizontal:
            return self.columns[section][1]
        return None

    def set_days(self, days):
        self.days = days
        self.reload()

    def reload(self):
        self.beginResetModel()
        self.rows = self.store.binance_daily_volume_rows(self.symbols, self.days)
        self.endResetModel()


class ChartWidget(QWidget):
    def __init__(self, title: str, chart_type: str):
        super().__init__()
        self.title = title
        self.chart_type = chart_type
        self.values = []
        self.setMinimumHeight(150)

    def set_values(self, values):
        self.values = list(values)
        self.update()

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)
        rect = self.rect().adjusted(10, 10, -10, -10)
        painter.setPen(QColor("#7b8da3"))
        painter.drawText(rect.left(), rect.top() + 14, self.title)
        chart = rect.adjusted(0, 24, 0, 0)
        painter.fillRect(chart, QColor("#0b1118"))
        painter.setPen(QPen(QColor("#1a2634"), 1))
        painter.drawRoundedRect(chart, 7, 7)
        if not self.values:
            painter.setPen(QColor("#6f8094"))
            painter.drawText(chart, Qt.AlignCenter, "暂无成交数据")
            return
        max_v = max(max(self.values), 1)
        min_v = min(self.values)
        span = max(max_v - min_v, 1)
        if self.chart_type == "bar":
            width = chart.width() / max(len(self.values), 1)
            painter.setBrush(QColor("#23c483"))
            painter.setPen(Qt.NoPen)
            for i, value in enumerate(self.values):
                h = (value / max_v) * (chart.height() - 18)
                painter.drawRect(int(chart.left() + i * width + 2), int(chart.bottom() - h), max(2, int(width - 4)), int(h))
        elif self.chart_type == "donut":
            size = min(chart.width(), chart.height()) - 26
            x = chart.center().x() - size // 2
            y = chart.center().y() - size // 2
            total = sum(self.values) or 1
            start = 90 * 16
            colors = ["#f4c430", "#23c483", "#3b82f6", "#ef4444"]
            for i, value in enumerate(self.values):
                span_angle = int(-(value / total) * 360 * 16)
                painter.setBrush(QColor(colors[i % len(colors)]))
                painter.setPen(Qt.NoPen)
                painter.drawPie(x, y, size, size, start, span_angle)
                start += span_angle
            painter.setBrush(QColor("#0b1118"))
            painter.drawEllipse(x + size // 4, y + size // 4, size // 2, size // 2)
        else:
            points = []
            for i, value in enumerate(self.values):
                x = chart.left() + (i / max(len(self.values) - 1, 1)) * chart.width()
                y = chart.bottom() - ((value - min_v) / span) * (chart.height() - 18) - 8
                points.append((x, y))
            if self.chart_type == "area":
                painter.setBrush(QColor(59, 130, 246, 45))
            painter.setPen(QPen(QColor("#f4c430"), 2))
            for i in range(1, len(points)):
                painter.drawLine(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1])


class KpiCard(QFrame):
    def __init__(self, label: str):
        super().__init__()
        self.setObjectName("Card")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 10, 12, 10)
        self.label = QLabel(label)
        self.label.setObjectName("Muted")
        self.value = QLabel("-")
        self.value.setObjectName("KpiValue")
        layout.addWidget(self.label)
        layout.addWidget(self.value)

    def set_value(self, value: str):
        self.value.setText(value)


class AccordionSection(QFrame):
    expanded_changed = Signal(bool)

    def __init__(self, title: str, content: QWidget, expanded: bool = False):
        super().__init__()
        self.setObjectName("Card")
        self.base_title = title
        self.content = content
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        self.toggle = QPushButton(title)
        self.toggle.setCheckable(True)
        self.toggle.setChecked(expanded)
        self.toggle.clicked.connect(self.set_expanded)
        self.toggle.setStyleSheet("text-align: left; padding: 10px 12px; border: 0; border-bottom: 1px solid #1a2634; border-radius: 8px 8px 0 0;")
        layout.addWidget(self.toggle)
        self.content.setVisible(expanded)
        layout.addWidget(self.content)
        self.set_expanded(expanded)

    def set_expanded(self, expanded: bool):
        self.toggle.setChecked(expanded)
        self.content.setVisible(expanded)
        self.toggle.setText(("收起 " if expanded else "展开 ") + self.base_title)
        self.expanded_changed.emit(expanded)


class LogPanel(QFrame):
    def __init__(self):
        super().__init__()
        self.setObjectName("Card")
        self.logs = []
        layout = QVBoxLayout(self)
        head = QHBoxLayout()
        title = QLabel("执行日志")
        title.setObjectName("PanelTitle")
        self.level_filter = QComboBox()
        self.level_filter.addItems(["全部", "INFO", "WARN", "ERROR", "SUCCESS", "NETWORK", "TRADE", "PREDICTOR"])
        self.level_filter.currentTextChanged.connect(self.render)
        self.search = QLineEdit()
        self.search.setPlaceholderText("搜索日志")
        self.search.textChanged.connect(self.render)
        copy_btn = QPushButton("复制")
        export_btn = QPushButton("导出")
        copy_btn.clicked.connect(self.copy_logs)
        export_btn.clicked.connect(self.export_logs)
        head.addWidget(title)
        head.addStretch()
        head.addWidget(self.level_filter)
        head.addWidget(self.search)
        head.addWidget(copy_btn)
        head.addWidget(export_btn)
        self.text = QTextEdit()
        self.text.setReadOnly(True)
        self.text.setContextMenuPolicy(Qt.CustomContextMenu)
        self.text.customContextMenuRequested.connect(self.menu)
        layout.addLayout(head)
        layout.addWidget(self.text)

    def add(self, level: str, message: str):
        self.logs.insert(0, (datetime.now().strftime("%H:%M:%S"), level, message))
        self.logs = self.logs[:1000]
        self.render()

    def render(self):
        q = self.search.text().lower()
        selected = self.level_filter.currentText() if hasattr(self, "level_filter") else "全部"
        colors = {"SUCCESS": "#23c483", "WARN": "#f59e0b", "ERROR": "#ef4444", "INFO": "#60a5fa", "NETWORK": "#38bdf8", "TRADE": "#f4c430", "PREDICTOR": "#a78bfa"}
        lines = []
        for ts, level, message in self.logs:
            if selected != "全部" and level != selected:
                continue
            if q and q not in message.lower() and q not in level.lower():
                continue
            color = colors.get(level, "#d8e0ea")
            lines.append(f'<span style="color:#708195">{ts}</span> <b style="color:{color}">{level}</b> {message}')
        self.text.setHtml("<br>".join(lines))

    def copy_logs(self):
        QApplication.clipboard().setText("\n".join(f"{ts} {level} {message}" for ts, level, message in self.logs))

    def export_logs(self):
        path, _ = QFileDialog.getSaveFileName(self, "导出日志", "aoe-dashboard.log", "Log Files (*.log);;Text Files (*.txt)")
        if path:
            Path(path).write_text("\n".join(f"{ts} {level} {message}" for ts, level, message in self.logs), encoding="utf-8")

    def menu(self, point):
        menu = QMenu(self)
        menu.addAction("复制", self.copy_logs)
        menu.exec(self.text.mapToGlobal(point))
class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.store = Store(DB_PATH)
        self.market_client = MarketDataClient()
        self.predictor_client = DailyVolumePredictorClient(ROOT_DIR)
        self.predictor_clients = {"BNB/USDT": self.predictor_client}
        self.daily_volume_client = BinanceDailyVolumeClient(["BNBUSDT", "SOLUSDT", "ETHUSDT"])
        self.discovery = ContractDiscovery(ROOT_DIR)
        self.network_executor = ThreadPoolExecutor(max_workers=3, thread_name_prefix="aoe-network")
        self.network_signals = NetworkSignals()
        self.network_signals.market_loaded.connect(self.on_market_loaded)
        self.network_signals.market_failed.connect(self.on_market_failed)
        self.network_signals.discovery_loaded.connect(self.on_discovery_loaded)
        self.network_signals.discovery_failed.connect(self.on_discovery_failed)
        self.network_signals.predictor_loaded.connect(self.on_predictor_loaded)
        self.network_signals.predictor_failed.connect(self.on_predictor_failed)
        self.network_signals.stats_loaded.connect(self.on_stats_loaded)
        self.network_signals.stats_failed.connect(self.on_stats_failed)
        self.network_signals.auto_market_loaded.connect(self.on_auto_market_loaded)
        self.network_signals.auto_market_failed.connect(self.on_auto_market_failed)
        self.market_fetching = False
        self.discovery_fetching = False
        self.predictor_fetching = False
        self.stats_fetching = False
        env = load_env(ROOT_DIR / ".env")
        self.env = env
        self.auto_mode = env.get("AUTO_MODE", "SMART").upper()
        self.auto_buy_amount = env.get("PRIMARY_BUY_USDT", env.get("AUTO_BUY_AMOUNT_USDT", "5"))
        self.auto_secondary_buy_amount = env.get("SECONDARY_BUY_USDT", env.get("AUTO_SECONDARY_BUY_AMOUNT_USDT", "0"))
        self.auto_buy_max_price = env.get("AUTO_MAX_OUTCOME_PRICE", env.get("AUTO_BUY_MAX_PRICE", "0.45"))
        self.min_confidence = float(env.get("MIN_CONFIDENCE", "60"))
        self.auto_skip_below = float(env.get("AUTO_SKIP_IF_DAILY_VOL_BELOW", "100000000"))
        self.auto_skip_above = float(env.get("AUTO_SKIP_IF_DAILY_VOL_ABOVE", "1000000000"))
        self.auto_predict_interval_seconds = max(5, int(env.get("AUTO_PREDICT_INTERVAL_SECONDS", "60")))
        self.automation_enabled = self.store.setting("auto_buy_enabled", "0") == "1"
        self.fixed_ladder_enabled = self.store.setting("auto_fixed_ladder_enabled", "0") == "1"
        self.auto_market_fetching = False
        self.auto_next_attempt_at = None
        self.auto_attempted_day = None
        self.auto_run_day = None
        self.auto_process = None
        self.auto_market_for_run = None
        self.auto_buy_queue = []
        self.auto_current_target = None
        self.auto_current_is_test = False
        self.auto_current_tx_hash = None
        self.auto_pair_amounts = {"BTC/USDT": "2", "SOL/USDT": "2", "ETH/USDT": "2"}
        self.volume_history_logged = False
        self.last_predictor_mode = None
        self.setWindowTitle(APP_NAME)
        self.resize(1280, 820)
        self.setMinimumSize(1024, 680)
        self.target_time = self.next_auto_scan_time()
        self.hourly_turnover = 0.0
        self.build_ui()
        self.update_page_labels()
        self.install_timers()
        self.refresh_kpi()
        self.refresh_countdown()
        QTimer.singleShot(100, self.refresh_market_data)
        QTimer.singleShot(500, self.discover_tomorrow_contract)
        QTimer.singleShot(900, self.refresh_predictor)
        self.log.add("INFO", "AOE Dashboard 原生交易终端已启动")
        self.log.add("SUCCESS", "SQLite runtime-state/trades.db 已连接")
        self.log.add("INFO", "SMART 自动买入：07:59:30 预扫描 BNB/BTC/SOL/ETH 明日合约，08:00 后按各自 UTC Daily Vol 预测区间")
        self.log.add("INFO", "自动买入当前状态：" + ("已启用" if self.automation_enabled else "未启用"))

    @staticmethod
    def next_auto_scan_time(now=None):
        current = now or datetime.now(BEIJING_TZ)
        target = current.replace(hour=7, minute=59, second=30, microsecond=0)
        if target <= current:
            target += timedelta(days=1)
        return target

    def build_ui(self):
        root = QWidget()
        outer = QVBoxLayout(root)
        outer.setSizeConstraint(QLayout.SetMinimumSize)
        outer.setContentsMargins(12, 12, 12, 12)
        outer.setSpacing(10)
        self.kpi_cards = {}
        kpi_grid = QGridLayout()
        labels = ["USDT余额", "BNB余额", "今日成交额", "今日Gas", "今日成功次数", "最近更新时间"]
        for i, label in enumerate(labels):
            card = KpiCard(label)
            self.kpi_cards[label] = card
            kpi_grid.addWidget(card, 0, i)
        outer.addLayout(kpi_grid)
        top = QHBoxLayout()
        top.addWidget(self.config_panel(), 3)
        top.addWidget(self.execution_panel(), 5)
        outer.addLayout(top, 3)
        outer.addWidget(self.market_panel(), 3)
        self.predictor_section = AccordionSection("Daily Volume Predictor", self.predictor_panel(), expanded=True)
        outer.addWidget(self.predictor_section)
        self.log = LogPanel()
        outer.addWidget(AccordionSection("日志", self.log, expanded=False))
        self.history_section = AccordionSection("历史成交", self.history_panel(), expanded=False)
        self.history_section.expanded_changed.connect(self.on_history_expanded)
        outer.addWidget(self.history_section)
        self.stats_section = AccordionSection("BNB / BTC / SOL / ETH 合约日成交额历史", self.stats_panel(), expanded=False)
        self.stats_section.expanded_changed.connect(self.on_stats_expanded)
        outer.addWidget(self.stats_section)
        outer.addStretch()
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setFrameShape(QFrame.NoFrame)
        self.scroll.setWidget(root)
        self.setCentralWidget(self.scroll)

    def config_panel(self):
        box = QFrame(); box.setObjectName("Card")
        layout = QVBoxLayout(box)
        head = QHBoxLayout(); title = QLabel("交易对配置"); title.setObjectName("PanelTitle")
        add_btn = QPushButton("新增交易对"); add_btn.clicked.connect(self.add_pair_row)
        self.config_more_btn = QPushButton("高级参数")
        self.config_more_btn.setCheckable(True)
        self.config_more_btn.toggled.connect(self.toggle_config_advanced)
        head.addWidget(title); head.addStretch(); head.addWidget(self.config_more_btn); head.addWidget(add_btn)
        self.pair_table = QTableWidget(0, 8)
        self.pair_table.setHorizontalHeaderLabels(["启用", "交易对", "买入金额", "Gas倍数", "最大Gas", "重试次数", "每日最大次数", "优先级"])
        self.pair_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.pair_table.verticalHeader().setVisible(False)
        for row in [[True, "BNB/USDT", self.auto_buy_amount, "1.25", "0.25", "3", "1", "1"], [True, "BTC/USDT", "2", "1.20", "0.20", "3", "1", "2"], [True, "SOL/USDT", "2", "1.20", "0.20", "3", "1", "3"], [True, "ETH/USDT", "2", "1.20", "0.20", "3", "1", "4"]]:
            self.add_pair_row(row)
        self.toggle_config_advanced(False)
        self.auto_rule = QLabel("SMART：07:59:30 预扫描；08:00 后 BNB 5 USDT；BTC/SOL/ETH 各 2 USDT 按策略")
        self.auto_rule.setObjectName("Muted")
        self.fixed_ladder_check = QCheckBox("固定阶梯：300M-450M 买入 5 USDT")
        self.fixed_ladder_check.setChecked(self.fixed_ladder_enabled)
        self.fixed_ladder_check.toggled.connect(self.on_fixed_ladder_toggled)
        self.tomorrow_contract = QLineEdit(""); self.tomorrow_contract.setReadOnly(True)
        self.discover_btn = QPushButton("发现明日合约"); self.discover_btn.clicked.connect(self.discover_tomorrow_contract)
        self.start_btn = QPushButton("停止自动买入" if self.automation_enabled else "启用自动买入"); self.start_btn.clicked.connect(self.toggle_running)
        footer = QHBoxLayout(); footer.addWidget(QLabel("明日合约")); footer.addWidget(self.tomorrow_contract, 1); footer.addWidget(self.discover_btn); footer.addWidget(self.start_btn)
        layout.addLayout(head); layout.addWidget(self.pair_table); layout.addWidget(self.auto_rule); layout.addWidget(self.fixed_ladder_check); layout.addLayout(footer)
        return box

    def on_fixed_ladder_toggled(self, checked: bool):
        self.fixed_ladder_enabled = checked
        self.store.set_setting("auto_fixed_ladder_enabled", "1" if checked else "0")
        mode = "固定阶梯" if checked else "SMART"
        self.log.add("INFO", f"自动买入方案已切换：{mode}")

    def toggle_config_advanced(self, expanded: bool):
        for col in range(2, 8):
            self.pair_table.setColumnHidden(col, not expanded)
        self.config_more_btn.setText("收起高级参数" if expanded else "高级参数")

    def add_pair_row(self, values=None):
        if values is None: values = [True, "", "100", "1.20", "0.20", "3", "12", "9"]
        row = self.pair_table.rowCount(); self.pair_table.insertRow(row)
        check = QTableWidgetItem(""); check.setFlags(check.flags() | Qt.ItemIsUserCheckable); check.setCheckState(Qt.Checked if values[0] else Qt.Unchecked)
        self.pair_table.setItem(row, 0, check)
        for col, value in enumerate(values[1:], start=1): self.pair_table.setItem(row, col, QTableWidgetItem(str(value)))

    def execution_panel(self):
        box = QFrame(); box.setObjectName("Card")
        layout = QVBoxLayout(box)
        head = QHBoxLayout()
        title = QLabel("AOE 执行终端"); title.setObjectName("PanelTitle")
        self.test_buy_btn = QPushButton("测试不发送交易")
        self.test_buy_btn.clicked.connect(self.launch_test_buy)
        head.addWidget(title); head.addStretch(); head.addWidget(self.test_buy_btn)
        self.countdown = QLabel("--:--:--"); self.countdown.setObjectName("Countdown"); self.countdown.setAlignment(Qt.AlignCenter)
        self.status_lights = {}; status_row = QHBoxLayout()
        for name in ["等待", "扫描", "就绪", "提交中", "成功", "失败"]:
            label = QLabel(f"● {name}"); label.setObjectName("StatusLight"); self.status_lights[name] = label; status_row.addWidget(label)
        self.exec_metrics = {}; metrics_grid = QGridLayout()
        labels = ["网络状态", "提交状态", "钱包状态", "Quote 延迟", "RPC 延迟", "签名耗时", "广播耗时", "确认耗时", "总耗时", "区块高度", "当前Gas", "优先费", "基础费", "目标Gas", "最新TX", "最近失败原因"]
        for i, label in enumerate(labels):
            k = QLabel(label); k.setObjectName("Muted"); v = QLabel("无数据"); v.setObjectName("Mono"); self.exec_metrics[label] = v
            metrics_grid.addWidget(k, i // 4 * 2, i % 4); metrics_grid.addWidget(v, i // 4 * 2 + 1, i % 4)
        layout.addLayout(head); layout.addWidget(self.countdown); layout.addLayout(status_row); layout.addLayout(metrics_grid)
        return box

    def market_panel(self):
        box = QFrame(); box.setObjectName("Card"); layout = QVBoxLayout(box); head = QHBoxLayout()
        title = QLabel("市场监控"); title.setObjectName("PanelTitle")
        self.market_search = QLineEdit(); self.market_search.setPlaceholderText("搜索/筛选")
        self.market_size = QComboBox(); self.market_size.addItems(["20", "50", "100"])
        self.market_prev = QPushButton("上一页"); self.market_next = QPushButton("下一页"); self.market_refresh = QPushButton("刷新行情"); self.market_page = QLabel("")
        self.market_more_btn = QPushButton("展开更多")
        self.market_more_btn.setCheckable(True)
        self.market_more_btn.toggled.connect(self.toggle_market_advanced)
        head.addWidget(title); head.addStretch()
        for w in [self.market_search, self.market_size, self.market_more_btn, self.market_refresh, self.market_prev, self.market_next, self.market_page]: head.addWidget(w)
        self.market_model = PagedTableModel(self.store, "market"); self.market_model.reload(); self.market_view = QTableView(); self.setup_table(self.market_view, self.market_model)
        self.market_search.textChanged.connect(self.market_model.set_search); self.market_size.currentTextChanged.connect(lambda value: self.market_model.set_page_size(int(value)))
        self.market_prev.clicked.connect(self.market_model.prev_page); self.market_next.clicked.connect(self.market_model.next_page); self.market_refresh.clicked.connect(self.refresh_market_data)
        self.market_model.modelReset.connect(self.update_page_labels)
        self.toggle_market_advanced(False)
        self.no_market_label = QLabel("正在刷新 Binance Futures 行情...")
        self.no_market_label.setObjectName("Muted")
        self.no_market_label.setAlignment(Qt.AlignCenter)
        self.no_market_label.setMinimumHeight(64)
        layout.addLayout(head); layout.addWidget(self.market_view); layout.addWidget(self.no_market_label); return box

    def toggle_market_advanced(self, expanded: bool):
        advanced = [2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14]
        for col in advanced:
            self.market_view.setColumnHidden(col, not expanded)
        self.market_more_btn.setText("收起更多" if expanded else "展开更多")
        for col in [0, 1, 5, 6, 15]:
            self.market_view.setColumnHidden(col, False)

    def predictor_panel(self):
        box = QFrame(); box.setObjectName("Card"); layout = QVBoxLayout(box)
        head = QHBoxLayout()
        note = QLabel("BNBUSDT Perpetual / UTC 1D Vol(USDT)"); note.setObjectName("Muted")
        self.predictor_mode_badge = QLabel("Normal Predictor")
        self.predictor_mode_badge.setObjectName("RangeBadge")
        self.predictor_close_alert = QLabel("停止交易倒计时：--")
        self.predictor_close_alert.setObjectName("CloseAlert")
        refresh_btn = QPushButton("刷新预测"); refresh_btn.clicked.connect(self.refresh_predictor); self.predictor_refresh_btn = refresh_btn
        export_btn = QPushButton("导出预测日志"); export_btn.clicked.connect(self.export_predictor_log)
        head.addWidget(note); head.addWidget(self.predictor_mode_badge); head.addStretch(); head.addWidget(self.predictor_close_alert); head.addWidget(refresh_btn); head.addWidget(export_btn)
        self.predictor_values = {}
        metrics = QGridLayout()
        labels = ["当前成交额", "完成度", "剩余时间", "最近15分钟速度", "最近1小时速度", "最近4小时速度", "预计收盘", "预测范围", "预测区间", "置信度", "7日均值", "30日均值", "目标区间", "当前价格", "判断状态"]
        for i, label in enumerate(labels):
            key = QLabel(label); key.setObjectName("Muted")
            value = QLabel("-"); value.setObjectName("Mono"); self.predictor_values[label] = value
            metrics.addWidget(key, (i // 7) * 2, i % 7)
            metrics.addWidget(value, (i // 7) * 2 + 1, i % 7)
        self.predictor_ranges_layout = QHBoxLayout()
        layout.addLayout(head); layout.addLayout(metrics); layout.addLayout(self.predictor_ranges_layout)
        return box

    def history_panel(self):
        box = QFrame(); box.setObjectName("Card"); layout = QVBoxLayout(box); head = QHBoxLayout()
        title = QLabel("历史成交"); title.setObjectName("PanelTitle")
        self.trade_range = QComboBox(); self.trade_range.addItems(["全部", "最近24小时", "最近7天", "最近30天"])
        self.trade_search = QLineEdit(); self.trade_search.setPlaceholderText("搜索")
        self.trade_size = QComboBox(); self.trade_size.addItems(["50", "100", "200", "500"])
        csv_btn = QPushButton("导出CSV"); excel_btn = QPushButton("导出Excel"); prev_btn = QPushButton("上一页"); next_btn = QPushButton("下一页"); self.trade_page = QLabel("")
        head.addWidget(title); head.addWidget(self.trade_range); head.addStretch()
        for w in [self.trade_search, self.trade_size, csv_btn, excel_btn, prev_btn, next_btn, self.trade_page]: head.addWidget(w)
        self.trade_model = PagedTableModel(self.store, "trades"); self.trade_view = QTableView(); self.setup_table(self.trade_view, self.trade_model)
        self.trade_search.textChanged.connect(self.trade_model.set_search); self.trade_size.currentTextChanged.connect(lambda value: self.trade_model.set_page_size(int(value)))
        self.trade_range.currentTextChanged.connect(self.trade_model.set_range)
        prev_btn.clicked.connect(self.trade_model.prev_page); next_btn.clicked.connect(self.trade_model.next_page); csv_btn.clicked.connect(lambda: self.export_trades("csv")); excel_btn.clicked.connect(lambda: self.export_trades("xls"))
        self.trade_model.modelReset.connect(self.update_page_labels)
        self.trade_view.setMinimumHeight(230)
        self.no_trade_label = QLabel("暂无真实成交记录（成功或失败的下单结果会显示在这里）"); self.no_trade_label.setObjectName("Muted"); self.no_trade_label.setAlignment(Qt.AlignCenter); self.no_trade_label.setMinimumHeight(64)
        layout.addLayout(head); layout.addWidget(self.trade_view); layout.addWidget(self.no_trade_label); return box

    def on_history_expanded(self, expanded: bool):
        if not expanded:
            return
        self.trade_model.reload()
        self.update_page_labels()
        QTimer.singleShot(0, lambda: self.scroll.ensureWidgetVisible(self.trade_view))

    def on_stats_expanded(self, expanded: bool):
        if not expanded:
            return
        self.refresh_stats()
        QTimer.singleShot(0, lambda: self.scroll.ensureWidgetVisible(self.daily_volume_tabs))

    def stats_panel(self):
        box = QFrame(); box.setObjectName("Card"); layout = QVBoxLayout(box); head = QHBoxLayout()
        source = QLabel("Binance Futures / UTC 1D Vol(USDT)"); source.setObjectName("Muted")
        self.stats_period = QComboBox(); self.stats_period.addItems(["7", "30", "90"]); self.stats_period.setCurrentText("30"); self.stats_period.currentTextChanged.connect(lambda _: self.refresh_stats())
        self.stats_refresh_btn = QPushButton("刷新日线"); self.stats_refresh_btn.clicked.connect(self.refresh_stats)
        head.addWidget(source); head.addStretch(); head.addWidget(QLabel("天数")); head.addWidget(self.stats_period); head.addWidget(self.stats_refresh_btn)
        self.daily_volume_models = {}
        self.daily_volume_views = {}
        self.daily_volume_tabs = QTabWidget()
        self.daily_volume_tabs.setMinimumHeight(420)
        for label, symbol in [("BNB", "BNBUSDT"), ("BTC", "BTCUSDT"), ("SOL", "SOLUSDT"), ("ETH", "ETHUSDT")]:
            model = DailyVolumeTableModel(self.store, [symbol])
            view = QTableView()
            self.setup_table(view, model)
            self.daily_volume_models[symbol] = model
            self.daily_volume_views[symbol] = view
            self.daily_volume_tabs.addTab(view, label)
        self.no_stats_label = QLabel("正在加载 Binance Futures 日线成交额..."); self.no_stats_label.setObjectName("Muted"); self.no_stats_label.setAlignment(Qt.AlignCenter)
        has_cached_stats = any(bool(model.rows) for model in self.daily_volume_models.values())
        self.daily_volume_tabs.setVisible(has_cached_stats)
        self.no_stats_label.setVisible(not has_cached_stats)
        layout.addLayout(head); layout.addWidget(self.daily_volume_tabs); layout.addWidget(self.no_stats_label); return box

    def setup_table(self, view: QTableView, model):
        view.setModel(model); view.setSortingEnabled(True); view.setAlternatingRowColors(True); view.verticalHeader().setVisible(False); view.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch); view.setSelectionBehavior(QTableView.SelectRows); view.setShowGrid(False)

    def install_timers(self):
        self.countdown_timer = QTimer(self); self.countdown_timer.timeout.connect(self.refresh_countdown); self.countdown_timer.start(1000)
        self.auto_timer = QTimer(self); self.auto_timer.timeout.connect(self.check_auto_buy_schedule); self.auto_timer.start(250)
        self.market_timer = QTimer(self); self.market_timer.timeout.connect(self.refresh_market_data); self.market_timer.start(60 * 60 * 1000)
        self.kpi_timer = QTimer(self); self.kpi_timer.timeout.connect(self.refresh_kpi); self.kpi_timer.start(3000)
        self.chart_timer = QTimer(self); self.chart_timer.timeout.connect(self.refresh_visible_stats); self.chart_timer.start(10 * 60 * 1000)
        self.predictor_timer = QTimer(self); self.predictor_timer.timeout.connect(self.refresh_predictor); self.predictor_timer.start(60000)

    def refresh_kpi(self):
        kpi = self.store.kpi()
        values = {"USDT余额": fmt_money(kpi["usdt_balance"]), "BNB余额": fmt_num(kpi["bnb_balance"]), "今日成交额": fmt_money(kpi["today_turnover"]), "今日Gas": fmt_money(kpi["today_gas"]), "今日成功次数": str(kpi["today_success"]), "最近更新时间": kpi["updated_at"]}
        for key, value in values.items(): self.kpi_cards[key].set_value(value)

    def refresh_hourly_turnover(self):
        self.hourly_turnover = self.store.kpi()["today_turnover"]
        if "\u6700\u8fd11\u5c0f\u65f6\u6210\u4ea4\u989d" in self.kpi_cards: self.kpi_cards["\u6700\u8fd11\u5c0f\u65f6\u6210\u4ea4\u989d"].set_value(fmt_money(self.hourly_turnover))
        self.log.add("INFO", f"\u6bcf\u5c0f\u65f6\u6210\u4ea4\u989d\u5df2\u5237\u65b0\uff1a{fmt_money(self.hourly_turnover)}")

    def refresh_hourly_turnover_if_top_of_hour(self):
        if datetime.now().minute == 0: self.refresh_hourly_turnover()

    def refresh_market_data(self):
        if self.market_fetching:
            return
        self.market_fetching = True
        self.market_refresh.setEnabled(False)
        self.market_refresh.setText("刷新中")
        if self.market_model.total == 0:
            self.no_market_label.setText("正在刷新 Binance Futures 行情...")
        self.network_executor.submit(self.fetch_market_data).add_done_callback(self.market_data_finished)

    def fetch_market_data(self):
        started = time.perf_counter()
        rows = self.market_client.fetch()
        return rows, (time.perf_counter() - started) * 1000

    def market_data_finished(self, future):
        try:
            rows, elapsed = future.result()
            self.network_signals.market_loaded.emit(rows, elapsed)
        except Exception as error:
            self.network_signals.market_failed.emit(str(error))

    def on_market_loaded(self, rows, elapsed):
        self.store.replace_market_snapshots(rows)
        self.store.record_network_metric("币安期货API", "在线", elapsed, 0, "")
        self.market_model.reload()
        self.update_page_labels()
        self.log.add("NETWORK", f"币安期货行情已刷新，用时 {elapsed:.0f}ms")
        self.finish_market_refresh()

    def on_market_failed(self, error):
        self.market_model.reload()
        if self.market_model.total == 0:
            self.no_market_label.setText(f"行情刷新失败：{error}")
        self.store.record_network_metric("币安期货API", "离线", 0, 1, error)
        self.log.add("ERROR", f"行情刷新失败：{error}")
        self.finish_market_refresh()

    def finish_market_refresh(self):
        self.market_fetching = False
        self.market_refresh.setText("刷新行情")
        self.market_refresh.setEnabled(True)

    def refresh_predictor(self):
        if self.predictor_fetching:
            return
        self.predictor_fetching = True
        self.predictor_refresh_btn.setEnabled(False)
        self.predictor_refresh_btn.setText("计算中")
        self.network_executor.submit(self.fetch_predictor).add_done_callback(self.predictor_finished)

    def fetch_predictor(self):
        started = time.perf_counter()
        result = self.predictor_client.fetch()
        return result, (time.perf_counter() - started) * 1000

    def predictor_finished(self, future):
        try:
            result, elapsed = future.result()
            self.network_signals.predictor_loaded.emit(result, elapsed)
        except Exception as error:
            self.network_signals.predictor_failed.emit(str(error))

    def on_predictor_loaded(self, result, elapsed):
        message = self.store.record_volume_prediction(result)
        mode = result.get("prediction_mode", "Normal Predictor")
        self.predictor_mode_badge.setText(mode)
        self.predictor_mode_badge.setProperty("active", bool(result.get("opening_snipe_active")))
        self.predictor_mode_badge.style().unpolish(self.predictor_mode_badge); self.predictor_mode_badge.style().polish(self.predictor_mode_badge)
        if mode != self.last_predictor_mode and result.get("opening_snipe_active"):
            self.log.add("PREDICTOR", "Opening Snipe Mode Active")
            self.log.add("PREDICTOR", "Skipping Daily Volume Lower Bound")
            self.log.add("PREDICTOR", "Using Historical Volume Prediction")
        self.last_predictor_mode = mode
        if not self.volume_history_logged:
            self.log.add("NETWORK", f"成交额历史数据已加载：BNBUSDT / {result['history_count']} 个已收盘 UTC 日")
            self.volume_history_logged = True
        selected = result.get("selected_range") or {}
        values = {
            "当前成交额": fmt_predictor_volume(result["current_volume"]),
            "完成度": f"{result['elapsed_pct']:.1f}%",
            "剩余时间": fmt_duration(result["remaining_seconds"]),
            "最近15分钟速度": f"{fmt_predictor_volume(result['speed_15m'])}/h",
            "最近1小时速度": f"{fmt_predictor_volume(result['speed_1h'])}/h",
            "最近4小时速度": f"{fmt_predictor_volume(result['speed_4h'])}/h",
            "预计收盘": fmt_predictor_volume(result["predicted_volume"]),
            "预测范围": f"{fmt_predictor_volume(result['lower_volume'])} ~ {fmt_predictor_volume(result['upper_volume'])}",
            "预测区间": result["predicted_range"],
            "置信度": f"{result['confidence']:.0f}%",
            "7日均值": fmt_predictor_volume(result["avg_7d"]),
            "30日均值": fmt_predictor_volume(result["avg_30d"]),
            "目标区间": result["target_range"],
            "当前价格": f"{selected.get('price', 0):.4f}" if selected else "-",
            "判断状态": result["status"],
        }
        for key, value in values.items():
            self.predictor_values[key].setText(value)
        close_text = f"距离停止交易：{fmt_duration(result['close_remaining'])}  ({result['close_at']})"
        self.predictor_close_alert.setText(close_text)
        if result["close_remaining"] <= 900:
            self.predictor_close_alert.setProperty("urgency", "critical")
        elif result["close_remaining"] <= 3600:
            self.predictor_close_alert.setProperty("urgency", "warning")
        else:
            self.predictor_close_alert.setProperty("urgency", "normal")
        self.predictor_close_alert.style().unpolish(self.predictor_close_alert); self.predictor_close_alert.style().polish(self.predictor_close_alert)
        while self.predictor_ranges_layout.count():
            item = self.predictor_ranges_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        for item in result["ranges"]:
            badge = QLabel(item["label"])
            badge.setObjectName("RangeBadge")
            badge.setProperty("active", item["label"] == result["predicted_range"])
            self.predictor_ranges_layout.addWidget(badge)
        self.predictor_ranges_layout.addStretch()
        if message != "预测刷新":
            self.log.add("PREDICTOR", f"{message}；区间置信度 {result['confidence']:.0f}%")
        self.store.record_network_metric("预测器", "在线", elapsed, 0, "")
        self.finish_predictor_refresh()

    def on_predictor_failed(self, error):
        self.predictor_values["判断状态"].setText("预测失败")
        self.store.record_network_metric("预测器", "离线", 0, 1, error)
        self.log.add("ERROR", f"Daily Volume Predictor 失败：{error}")
        self.finish_predictor_refresh()

    def finish_predictor_refresh(self):
        self.predictor_fetching = False
        self.predictor_refresh_btn.setText("刷新预测")
        self.predictor_refresh_btn.setEnabled(True)

    def discover_tomorrow_contract(self):
        if self.discovery_fetching:
            return
        self.discovery_fetching = True
        self.discover_btn.setEnabled(False)
        self.discover_btn.setText("发现中")
        self.network_executor.submit(self.fetch_tomorrow_contract).add_done_callback(self.tomorrow_contract_finished)

    def fetch_tomorrow_contract(self):
        started = time.perf_counter()
        tomorrow = datetime.now() + timedelta(days=1)
        markets = []
        for pair in ["BNB/USDT", "BTC/USDT", "SOL/USDT", "ETH/USDT"]:
            markets.append({"pair": pair, "market": self.discovery.discover_for_day(tomorrow.date(), pair)})
        return markets, (time.perf_counter() - started) * 1000

    def tomorrow_contract_finished(self, future):
        try:
            payload, elapsed = future.result()
            self.network_signals.discovery_loaded.emit(payload, elapsed)
        except Exception as error:
            self.network_signals.discovery_failed.emit(str(error))

    def on_discovery_loaded(self, payload, elapsed):
        self.store.record_network_metric("42 API", "在线", elapsed, 0, "")
        markets = payload if isinstance(payload, list) else [{"pair": "BNB/USDT", "market": payload}]
        found = [entry for entry in markets if entry.get("market")]
        if not found:
            self.tomorrow_contract.setText("未发现")
            self.log.add("WARN", "未发现明日 BNB/BTC/SOL/ETH AOE 合约")
        else:
            text = " | ".join(f"{entry['pair']}:{entry['market'].get('market_address')}" for entry in found)
            self.tomorrow_contract.setText(text)
            for entry in found:
                market = entry["market"]
                address = market.get("market_address") or ""
                title = market.get("title") or ""
                self.log.add("SUCCESS", f"已发现明日合约：{entry['pair']} {address} {title}")
            missing = [entry["pair"] for entry in markets if not entry.get("market")]
            if missing:
                self.log.add("WARN", "未发现明日合约：" + ", ".join(missing))
        self.finish_contract_discovery()

    def on_discovery_failed(self, error):
        self.tomorrow_contract.setText("发现失败")
        self.store.record_network_metric("42 API", "离线", 0, 1, error)
        self.log.add("ERROR", f"明日合约发现失败：{error}")
        self.finish_contract_discovery()

    def finish_contract_discovery(self):
        self.discovery_fetching = False
        self.discover_btn.setText("发现明日合约")
        self.discover_btn.setEnabled(True)

    def check_auto_buy_schedule(self):
        if not self.automation_enabled or self.auto_market_fetching:
            return
        if self.auto_process and self.auto_process.state() != QProcess.NotRunning:
            return
        now = datetime.now(BEIJING_TZ)
        scan_at = now.replace(hour=7, minute=59, second=30, microsecond=0)
        scan_until = scan_at + timedelta(hours=12, minutes=1)
        if not (scan_at <= now < scan_until):
            return
        if self.auto_attempted_day == scan_at.date():
            return
        if self.auto_next_attempt_at and now < self.auto_next_attempt_at:
            return
        event_day = (scan_at + timedelta(seconds=30)).astimezone(timezone.utc).date()
        self.auto_market_fetching = True
        self.auto_next_attempt_at = now + timedelta(seconds=self.auto_predict_interval_seconds)
        self.log.add("TRADE", f"SMART 扫描市场：UTC {event_day.isoformat()}")
        self.network_executor.submit(self.fetch_auto_market, event_day).add_done_callback(self.auto_market_finished)

    def fetch_auto_market(self, event_day):
        started = time.perf_counter()
        entries = []
        utc_now = datetime.now(timezone.utc)
        for pair, amount in self.auto_pairs_for_run().items():
            market = self.discovery.discover_for_day(event_day, pair)
            prediction = None
            if market and utc_now.date() >= event_day:
                client = self.predictor_clients.get(pair)
                if client is None:
                    client = DailyVolumePredictorClient(ROOT_DIR, pair)
                    self.predictor_clients[pair] = client
                prediction = client.fetch(market)
            entries.append({"pair": pair, "amount": amount, "market": market, "prediction": prediction})
        first_market = next((entry["market"] for entry in entries if entry["market"]), None)
        first_prediction = next((entry["prediction"] for entry in entries if entry["prediction"]), None)
        return {"market": first_market, "prediction": first_prediction, "entries": entries, "event_day": event_day}, (time.perf_counter() - started) * 1000

    def auto_market_finished(self, future):
        try:
            payload, elapsed = future.result()
            self.network_signals.auto_market_loaded.emit(payload, elapsed)
        except Exception as error:
            self.network_signals.auto_market_failed.emit(str(error))

    def auto_pairs_for_run(self):
        pairs = {}
        for row in range(self.pair_table.rowCount()):
            enabled = self.pair_table.item(row, 0)
            pair_item = self.pair_table.item(row, 1)
            amount_item = self.pair_table.item(row, 2)
            if not enabled or enabled.checkState() != Qt.Checked or not pair_item:
                continue
            pair = pair_item.text().strip().upper()
            if pair not in {"BNB/USDT", "BTC/USDT", "SOL/USDT", "ETH/USDT"}:
                continue
            amount = (amount_item.text() if amount_item else "").strip()
            if pair in {"BTC/USDT", "SOL/USDT", "ETH/USDT"}:
                amount = amount or self.auto_pair_amounts[pair]
            if amount:
                pairs[pair] = amount
        pairs.setdefault("BNB/USDT", self.auto_buy_amount)
        return pairs

    def on_auto_market_loaded(self, payload, elapsed):
        self.auto_market_fetching = False
        self.store.record_network_metric("42 AUTO", "在线", elapsed, 0, "")
        if not self.automation_enabled:
            return
        entries = payload.get("entries") if isinstance(payload, dict) else []
        market = payload.get("market") if isinstance(payload, dict) else payload
        if not entries:
            entries = [{"pair": "BNB/USDT", "amount": self.auto_buy_amount, "market": market, "prediction": payload.get("prediction") if isinstance(payload, dict) else None}]
        found_entries = [entry for entry in entries if entry.get("market")]
        if not found_entries:
            self.log.add("TRADE", "未发现目标日合约，稍后继续扫描")
            return
        discovered_text = " | ".join(f"{entry['pair']}:{entry['market'].get('market_address')}" for entry in found_entries)
        self.tomorrow_contract.setText(discovered_text)
        if not any(entry.get("prediction") for entry in found_entries):
            event_day = payload.get("event_day") if isinstance(payload, dict) else None
            if event_day:
                event_start = datetime.combine(event_day, datetime.min.time(), tzinfo=timezone.utc).astimezone(BEIJING_TZ)
                if datetime.now(BEIJING_TZ) < event_start:
                    self.auto_next_attempt_at = event_start
            self.log.add("TRADE", f"新市场已发现：{discovered_text}；等待 UTC 00:00 后执行预测")
            return

        orders = []
        for entry in found_entries:
            pair = entry["pair"]
            prediction = entry.get("prediction")
            if not prediction:
                self.log.add("WARN", f"{pair} 放弃买入：No Prediction")
                continue
            client = self.predictor_clients.get(pair, self.predictor_client)
            if not self.volume_history_logged and pair == "BNB/USDT":
                self.log.add("NETWORK", f"成交额历史数据已加载：BNBUSDT / {prediction['history_count']} 个已收盘 UTC 日")
                self.volume_history_logged = True
            self.store.record_volume_prediction(prediction)
            selected = prediction.get("selected_range")
            if not selected:
                reason = "No Predicted Outcome"
                client.history.record_prediction(prediction, "skip", reason)
                self.log.add("WARN", f"{pair} 放弃买入：{reason}")
                continue
            self.log.add(
                "PREDICTOR",
                f"{pair} 预测 {fmt_predictor_volume(prediction['predicted_volume'])} -> {selected['label']}，"
                f"置信度 {prediction['confidence']:.0f}% / 价格 {selected['price']:.4f}",
            )
            if prediction.get("opening_snipe_active"):
                self.log.add("PREDICTOR", f"{pair} Opening Snipe Mode Active")
                self.log.add("PREDICTOR", f"{pair} Skipping Daily Volume Lower Bound")
                self.log.add("PREDICTOR", f"{pair} Using Historical Volume Prediction")
            skip_reason = self.smart_skip_reason(prediction, selected, check_selected_price=not (self.fixed_ladder_enabled and pair == "BNB/USDT"))
            if skip_reason:
                client.history.record_prediction(prediction, "skip", skip_reason)
                self.log.add("WARN", f"{pair} 放弃买入：{skip_reason}")
                continue
            if self.fixed_ladder_enabled and pair == "BNB/USDT":
                pair_orders = self.build_fixed_ladder_orders(prediction)
            else:
                pair_orders = self.build_smart_orders(
                    prediction,
                    primary_amount=entry.get("amount"),
                    include_secondary=False,
                )
            for order in pair_orders:
                order["pair"] = pair
                order["_market"] = entry["market"]
                orders.append(order)
            strategy_name = "Fixed ladder" if self.fixed_ladder_enabled and pair == "BNB/USDT" else "SMART"
            client.history.record_prediction(prediction, "buy" if pair_orders else "skip", f"{strategy_name} filters passed" if pair_orders else "No Qualified Outcome")
        if not orders:
            self.log.add("WARN", "放弃买入：No Qualified Outcome")
            return
        scan_day = datetime.now(BEIJING_TZ).date().isoformat()
        self.auto_attempted_day = datetime.now(BEIJING_TZ).date()
        if not self.store.reserve_auto_buy_run(
            scan_day,
            str(found_entries[0]["market"].get("market_address") or ""),
            orders[0]["token_id"],
            sum(float(order["amount"]) for order in orders),
        ):
            self.log.add("WARN", f"{scan_day} \u81ea\u52a8\u4e70\u5165\u5df2\u542f\u52a8\u8fc7\uff0c\u4e0d\u91cd\u590d\u4e0b\u5355")
            return
        self.auto_run_day = scan_day
        self.auto_market_for_run = found_entries[0]["market"]
        self.auto_buy_queue = orders
        self.launch_next_auto_buy()

    def on_auto_market_failed(self, error):
        self.auto_market_fetching = False
        self.store.record_network_metric("42 AUTO", "离线", 0, 1, error)
        self.log.add("ERROR", f"SMART 扫描失败，将重试：{error}")

    def smart_skip_reason(self, prediction, selected, check_selected_price=True):
        if prediction["current_volume"] < self.auto_skip_below and not prediction.get("opening_snipe_active"):
            return "Daily Volume Below Limit"
        if prediction["current_volume"] > self.auto_skip_above:
            return "Daily Volume Above Limit"
        if prediction["confidence"] < self.min_confidence:
            return "Low Confidence"
        if check_selected_price and float(selected.get("price", 0)) > float(self.auto_buy_max_price):
            return "Outcome Overpriced"
        return ""

    def build_smart_orders(self, prediction, primary_amount=None, include_secondary=True):
        selected = prediction["selected_range"]
        orders = [
            {
                "range": selected["label"],
                "token_id": selected["token_id"],
                "amount": primary_amount or self.auto_buy_amount,
                "priority": True,
            }
        ]
        if not include_secondary or float(self.auto_secondary_buy_amount) <= 0:
            return orders
        alternatives = [item for item in prediction["ranges"] if item["token_id"] != selected["token_id"]]
        alternatives.sort(key=lambda item: self.range_distance(prediction["predicted_volume"], item))
        if alternatives and alternatives[0]["price"] <= float(self.auto_buy_max_price):
            orders.append({
                "range": alternatives[0]["label"],
                "token_id": alternatives[0]["token_id"],
                "amount": self.auto_secondary_buy_amount,
                "priority": False,
            })
        return orders

    def build_fixed_ladder_orders(self, prediction):
        targets = [
            (300_000_000.0, 450_000_000.0, self.auto_buy_amount, True),
        ]
        orders = []
        max_price = float(self.auto_buy_max_price)
        for low, high, amount, priority in targets:
            item = self.find_range_by_bounds(prediction["ranges"], low, high)
            label = f"{low / 1_000_000:.0f}M-{high / 1_000_000:.0f}M"
            if not item:
                self.log.add("WARN", f"固定阶梯未找到区间：{label}")
                continue
            if float(item.get("price", 0)) > max_price:
                self.log.add("WARN", f"固定阶梯跳过 {label}：价格 {float(item.get('price', 0)):.4f} 超过上限 {max_price:.4f}")
                continue
            orders.append({
                "range": item["label"],
                "token_id": item["token_id"],
                "amount": amount,
                "priority": priority,
            })
        return orders

    @staticmethod
    def find_range_by_bounds(ranges, low, high):
        for item in ranges:
            item_high = item["high"]
            if item["low"] == low and item_high is not None and item_high == high:
                return item
        return None

    @staticmethod
    def range_distance(value, item):
        if value < item["low"]:
            return item["low"] - value
        if item["high"] is not None and value >= item["high"]:
            return value - item["high"]
        return 0

    def launch_next_auto_buy(self):
        if not self.auto_buy_queue:
            return
        target = self.auto_buy_queue.pop(0)
        self.auto_current_target = target
        self.launch_auto_buy(target.get("_market") or self.auto_market_for_run, target)

    def launch_test_buy(self):
        if self.auto_process and self.auto_process.state() != QProcess.NotRunning:
            self.log.add("WARN", "已有买入或测试进程在运行")
            return
        market_address = self.tomorrow_contract.text().strip() or self.env.get("MARKET_ADDRESS", "")
        if not market_address:
            self.log.add("ERROR", "测试失败：缺少 MARKET_ADDRESS")
            return
        amount = (self.pair_table.item(0, 2).text() if self.pair_table.item(0, 2) else self.auto_buy_amount).strip() or self.auto_buy_amount
        target = {
            "range": "测试",
            "token_id": int(self.env.get("TARGET_TOKEN_ID", "4")),
            "amount": amount,
            "priority": True,
        }
        self.auto_current_target = target
        self.launch_auto_buy({"market_address": market_address}, target, dry_run=True)

    def launch_auto_buy(self, market, target, dry_run=False):
        script = ROOT_DIR / "scripts" / "aoe-onchain-buy.js"
        if not script.exists():
            self.log.add("ERROR", f"\u4e70\u5165\u811a\u672c\u4e0d\u5b58\u5728\uff1a{script}")
            if self.auto_run_day:
                self.store.finish_auto_buy_run(self.auto_run_day, "failed")
                self.auto_run_day = None
            return
        process = QProcess(self)
        process.setWorkingDirectory(str(ROOT_DIR))
        environment = QProcessEnvironment.systemEnvironment()
        environment.insert("MARKET_ADDRESS", str(market.get("market_address") or ""))
        environment.insert("TARGET_TOKEN_ID", str(target["token_id"]))
        environment.insert("TARGET_OUTCOME", "AOE")
        environment.insert("BUY_AMOUNT_USDT", str(target["amount"]))
        environment.insert("AOE_PAIR", str(target.get("pair") or "BNB/USDT"))
        environment.insert("MAX_PRICE", self.auto_buy_max_price)
        if dry_run:
            environment.insert("DRY_RUN", "1")
            environment.insert("DRY_RUN_MAX_WAIT_MS", "10000")
        process.setProcessEnvironment(environment)
        process.readyReadStandardOutput.connect(self.read_auto_buy_output)
        process.readyReadStandardError.connect(self.read_auto_buy_error)
        process.errorOccurred.connect(self.auto_buy_process_error)
        process.finished.connect(self.auto_buy_finished)
        self.auto_process = process
        self.auto_current_is_test = dry_run
        self.auto_current_tx_hash = None
        action = "测试买入（不发送交易）" if dry_run else "链上买入"
        self.log.add(
            "TRADE",
            f"启动{action} {target['amount']} USDT / {target.get('pair', 'BNB/USDT')} / {target['range']}：{market.get('market_address')}",
        )
        process.start("node", [str(script)])

    def auto_buy_process_error(self, error):
        if error == QProcess.FailedToStart:
            self.log.add("ERROR", "\u65e0\u6cd5\u542f\u52a8 Node \u4e70\u5165\u8fdb\u7a0b\uff0c\u8bf7\u68c0\u67e5 node \u547d\u4ee4\u662f\u5426\u53ef\u7528")

    def read_auto_buy_output(self):
        if not self.auto_process:
            return
        output = bytes(self.auto_process.readAllStandardOutput()).decode("utf-8", errors="replace")
        for line in output.splitlines():
            line = line.strip()
            if line:
                tx_match = re.search(r"0x[a-fA-F0-9]{64}", line)
                if tx_match:
                    self.auto_current_tx_hash = tx_match.group(0)
                self.log.add("TRADE", line)

    def send_weixin_buy_success_notification(self, target, tx_hash=None):
        if str(self.env.get("WEIXIN_BUY_NOTIFY", "1")).strip().lower() in {"0", "false", "no", "off"}:
            return
        pair = target.get("pair", "BNB/USDT")
        message = (
            "✅ 42 自动买入成功\n"
            f"交易对：{pair}\n"
            f"金额：{target.get('amount', '-')} USDT\n"
            f"区间：{target.get('range', '-')}\n"
            f"Token ID：{target.get('token_id', '-')}"
        )
        if tx_hash:
            message += f"\nTX：{tx_hash}"
        hermes_dir = Path(self.env.get("HERMES_AGENT_DIR") or "/root/.hermes/hermes-agent")
        if not hermes_dir.exists():
            raise RuntimeError(f"Hermes Agent 目录不存在：{hermes_dir}")
        if str(hermes_dir) not in sys.path:
            sys.path.insert(0, str(hermes_dir))
        for env_file in (Path.home() / ".hermes" / ".env", ROOT_DIR / ".env"):
            if env_file.exists():
                for key, value in load_env(env_file).items():
                    os.environ.setdefault(key, value)
        from tools.send_message_tool import send_message_tool
        response = send_message_tool({"action": "send", "target": self.env.get("WEIXIN_NOTIFY_TARGET", "weixin"), "message": message})
        try:
            payload = json.loads(response)
        except Exception:
            payload = {"raw": response}
        if isinstance(payload, dict) and payload.get("error"):
            raise RuntimeError(str(payload.get("error")))

    def send_weixin_buy_success_notification_finished(self, future):
        try:
            future.result()
            self.log.add("SUCCESS", "买入成功通知已发送到微信")
        except Exception as exc:
            self.log.add("WARN", f"微信买入成功通知发送失败：{exc}")

    def read_auto_buy_error(self):
        if not self.auto_process:
            return
        output = bytes(self.auto_process.readAllStandardError()).decode("utf-8", errors="replace")
        for line in output.splitlines():
            if line.strip():
                self.log.add("ERROR", line.strip())

    def auto_buy_finished(self, exit_code, exit_status):
        target = self.auto_current_target or {"amount": "-", "range": "-"}
        succeeded = exit_status == QProcess.NormalExit and exit_code == 0
        if self.auto_current_is_test:
            if succeeded:
                self.log.add("SUCCESS", f"测试完成：未发送交易，{target['amount']} USDT / {target['range']}")
            else:
                self.log.add("ERROR", f"测试失败：未发送交易，exit={exit_code}")
            self.auto_process = None
            self.auto_current_target = None
            self.auto_current_is_test = False
            self.auto_current_tx_hash = None
            return
        if succeeded:
            self.log.add("SUCCESS", f"自动买入完成：{target['amount']} USDT / {target.get('pair', 'BNB/USDT')} / {target['range']}")
            self.network_executor.submit(
                self.send_weixin_buy_success_notification,
                dict(target),
                self.auto_current_tx_hash,
            ).add_done_callback(self.send_weixin_buy_success_notification_finished)
        else:
            self.log.add("ERROR", f"自动买入失败：{target['amount']} USDT / {target.get('pair', 'BNB/USDT')} / {target['range']}，exit={exit_code}")
        self.trade_model.reload()
        self.update_page_labels()
        self.refresh_kpi()
        self.auto_process = None
        if succeeded and self.auto_buy_queue:
            self.log.add("TRADE", "优先订单成功，继续执行次级订单")
            self.launch_next_auto_buy()
            return
        result_status = "success" if succeeded else "failed"
        if not succeeded and self.auto_buy_queue:
            failed_pair = target.get("pair")
            before = len(self.auto_buy_queue)
            self.auto_buy_queue = [
                order for order in self.auto_buy_queue
                if order.get("pair") != failed_pair or order.get("priority")
            ]
            if len(self.auto_buy_queue) != before:
                self.log.add("WARN", f"{failed_pair} 优先订单未成功，取消同交易对低优先级买入")
            if self.auto_buy_queue:
                self.launch_next_auto_buy()
                return
        if self.auto_run_day:
            self.store.finish_auto_buy_run(self.auto_run_day, result_status)
        self.auto_run_day = None
        self.auto_market_for_run = None
        self.auto_current_target = None
        self.auto_current_is_test = False
        self.auto_current_tx_hash = None

    def runtime_state(self):
        metric, execution = self.store.latest_execution_metrics()
        if execution:
            try: age = datetime.now() - datetime.fromisoformat(str(execution["ts"]).replace("Z", ""))
            except Exception: age = timedelta(days=999)
            if age.total_seconds() <= 60:
                if execution["status"] in {"success", "confirmed"}: return "\u6210\u529f"
                if execution["status"] in {"failed", "error"}: return "\u5931\u8d25"
                if execution["status"] in {"submitting", "pending"}: return "\u63d0\u4ea4\u4e2d"
        return "\u7b49\u5f85"

    def refresh_countdown(self):
        now = datetime.now(BEIJING_TZ)
        if self.target_time <= now:
            self.target_time = self.next_auto_scan_time(now)
        remaining = max(0, int((self.target_time - now).total_seconds()))
        h, rem = divmod(remaining, 3600); m, s = divmod(rem, 60); self.countdown.setText(f"{h:02d}:{m:02d}:{s:02d}")
        active = self.runtime_state()
        for name, label in self.status_lights.items(): label.setProperty("active", name == active); label.style().unpolish(label); label.style().polish(label)
        metric, execution = self.store.latest_execution_metrics(); statuses = self.store.connection_statuses()
        self.exec_metrics["\u7f51\u7edc\u72b6\u6001"].setText(statuses["\u5e01\u5b89\u671f\u8d27API"]["status"]); self.exec_metrics["\u63d0\u4ea4\u72b6\u6001"].setText(active); self.exec_metrics["\u94b1\u5305\u72b6\u6001"].setText(statuses["\u94b1\u5305"]["status"])
        values = {"Quote 延迟": metric["quote_rtt_ms"] if metric else None, "RPC 延迟": metric["rpc_rtt_ms"] if metric else None, "\u7b7e\u540d\u8017\u65f6": metric["signature_ms"] if metric else (execution["signature_ms"] if execution else None), "\u5e7f\u64ad\u8017\u65f6": metric["broadcast_ms"] if metric else (execution["broadcast_ms"] if execution else None), "\u786e\u8ba4\u8017\u65f6": metric["confirmation_ms"] if metric else (execution["confirmation_ms"] if execution else None), "\u603b\u8017\u65f6": metric["total_ms"] if metric else (execution["total_ms"] if execution else None), "\u533a\u5757\u9ad8\u5ea6": metric["block_height"] if metric else None, "\u5f53\u524dGas": metric["current_gas_gwei"] if metric else None, "优先费": metric["priority_fee_gwei"] if metric else None, "基础费": metric["base_fee_gwei"] if metric else None, "\u76ee\u6807Gas": metric["target_gas_usdt"] if metric else None}
        for key, value in values.items():
            self.exec_metrics[key].setText("\u65e0\u6570\u636e" if value is None else (f"{float(value):.0f}ms" if key in {"Quote 延迟", "RPC 延迟", "\u7b7e\u540d\u8017\u65f6", "\u5e7f\u64ad\u8017\u65f6", "\u786e\u8ba4\u8017\u65f6", "\u603b\u8017\u65f6"} else (fmt_money(float(value)) if key == "\u76ee\u6807Gas" else str(value))))
        self.exec_metrics["\u6700\u65b0TX"].setText((execution["tx_hash"] or "\u65e0\u6570\u636e")[:34] if execution else "\u65e0\u6570\u636e")
        fail = metric["failure_reason"] if metric and metric["failure_reason"] else (execution["error"] if execution and execution["error"] else None); self.exec_metrics["\u6700\u8fd1\u5931\u8d25\u539f\u56e0"].setText(fail or "\u65e0\u6570\u636e")

    def refresh_risk_center(self):
        kpi = self.store.kpi(); wallet = self.store.latest_wallet_snapshot()
        max_trade = self.store.conn.execute("SELECT COALESCE(MAX(amount_usdt),0) v FROM executions WHERE date(ts)=date('now')").fetchone()["v"]
        max_gas = self.store.conn.execute("SELECT COALESCE(MAX(gas_usdt),0) v FROM executions WHERE date(ts)=date('now')").fetchone()["v"]
        last_error = self.store.conn.execute("SELECT error FROM executions WHERE error IS NOT NULL AND error!='' ORDER BY ts DESC LIMIT 1").fetchone()
        risk = "\u7ea2\u8272" if kpi["consecutive_failures"] >= 3 or kpi["today_failed"] >= 5 else ("\u9ec4\u8272" if kpi["today_failed"] > 0 else "\u7eff\u8272")
        values = {"\u8d26\u6237\u4f59\u989d": fmt_money(wallet["account_balance"]), "\u53ef\u7528\u4f59\u989d": fmt_money(wallet["available_balance"]), "\u4eca\u65e5\u4ea4\u6613\u6b21\u6570": str(kpi["today_trades"]), "\u4eca\u65e5Gas": fmt_money(kpi["today_gas"]), "\u5931\u8d25\u6b21\u6570": str(kpi["today_failed"]), "\u8fde\u7eed\u5931\u8d25": str(kpi["consecutive_failures"]), "\u5f02\u5e38\u505c\u6b62\u72b6\u6001": "?", "\u98ce\u9669\u7b49\u7ea7": risk, "\u8d26\u6237\u5065\u5eb7\u5ea6": f"{wallet['health_score']}%" if wallet["health_score"] else "\u65e0\u6570\u636e", "\u6700\u5927\u5355\u6b21\u6210\u4ea4": fmt_money(max_trade), "\u6700\u5927\u5355\u6b21Gas": fmt_money(max_gas), "\u6700\u8fd1\u4e00\u6b21\u5f02\u5e38": last_error["error"] if last_error else "\u65e0\u6570\u636e", "\u6700\u8fd1\u4e00\u6b21\u91cd\u8bd5": "\u65e0\u6570\u636e"}
        for key, value in values.items(): self.risk_labels[key].setText(str(value))

    def refresh_connection_status(self):
        statuses = self.store.connection_statuses(); self.connection_table.setRowCount(0)
        for source, row in statuses.items():
            index = self.connection_table.rowCount(); self.connection_table.insertRow(index)
            values = [source, row["status"], f"{row['latency_ms']}ms", str(row["ts"])[11:19] if row["ts"] != "-" else "-", str(row["error_count"])]
            for col, value in enumerate(values):
                item = QTableWidgetItem(value)
                if col == 1: item.setForeground({"\u5728\u7ebf": QColor("#23c483"), "\u91cd\u8fde\u4e2d": QColor("#f59e0b"), "\u79bb\u7ebf": QColor("#ef4444")}.get(value, QColor("#d8e0ea")))
                self.connection_table.setItem(index, col, item)

    def refresh_stats(self):
        if self.stats_fetching:
            return
        self.stats_fetching = True
        self.stats_refresh_btn.setEnabled(False)
        self.stats_refresh_btn.setText("加载中")
        days = int(self.stats_period.currentText()) if hasattr(self, "stats_period") else 30
        self.network_executor.submit(self.fetch_stats, days).add_done_callback(self.stats_finished)

    def refresh_visible_stats(self):
        if self.stats_section.toggle.isChecked():
            self.refresh_stats()

    def fetch_stats(self, days):
        started = time.perf_counter()
        rows = self.daily_volume_client.fetch(max(days, 30))
        return days, rows, (time.perf_counter() - started) * 1000

    def stats_finished(self, future):
        try:
            days, rows, elapsed = future.result()
            self.network_signals.stats_loaded.emit((days, rows), elapsed)
        except Exception as error:
            self.network_signals.stats_failed.emit(str(error))

    def on_stats_loaded(self, payload, elapsed):
        days, fetched_rows = payload
        self.store.replace_binance_daily_volumes(fetched_rows)
        has_data = False
        for model in self.daily_volume_models.values():
            model.set_days(days)
            has_data = has_data or bool(model.rows)
        self.no_stats_label.setText("暂无 Binance Futures 日线数据")
        self.no_stats_label.setVisible(not has_data)
        self.daily_volume_tabs.setVisible(has_data)
        self.store.record_network_metric("币安期货日线", "在线", elapsed, 0, "")
        total_rows = sum(len(model.rows) for model in self.daily_volume_models.values())
        self.log.add("NETWORK", f"BNB / BTC / SOL / ETH UTC 日线已刷新，共 {total_rows} 条记录")
        self.finish_stats_refresh()

    def on_stats_failed(self, error):
        self.no_stats_label.setText(f"日线数据加载失败：{error}")
        self.no_stats_label.setVisible(True)
        self.daily_volume_tabs.setVisible(False)
        self.store.record_network_metric("币安期货日线", "离线", 0, 1, error)
        self.log.add("ERROR", f"统计分析加载失败：{error}")
        self.finish_stats_refresh()

    def finish_stats_refresh(self):
        self.stats_fetching = False
        self.stats_refresh_btn.setText("刷新日线")
        self.stats_refresh_btn.setEnabled(True)

    def update_page_labels(self):
        self.market_page.setText(f"{self.market_model.page}/{max(1, math.ceil(self.market_model.total / self.market_model.page_size))}"); self.trade_page.setText(f"{self.trade_model.page}/{max(1, math.ceil(self.trade_model.total / self.trade_model.page_size))}")
        has_trades = self.trade_model.total > 0
        self.trade_view.setVisible(has_trades)
        self.no_trade_label.setVisible(not has_trades)
        if hasattr(self, "market_view") and hasattr(self, "no_market_label"):
            has_market_rows = self.market_model.total > 0
            self.market_view.setVisible(has_market_rows)
            self.no_market_label.setVisible(not has_market_rows)

    def show_market_columns_menu(self):
        menu = QMenu(self)
        for col in range(self.market_model.columnCount()):
            name = self.market_model.headerData(col, Qt.Horizontal, Qt.DisplayRole); action = QAction(name, self, checkable=True); action.setChecked(not self.market_view.isColumnHidden(col)); action.toggled.connect(lambda checked, c=col: self.market_view.setColumnHidden(c, not checked)); menu.addAction(action)
        menu.exec(self.column_menu_btn.mapToGlobal(self.column_menu_btn.rect().bottomLeft()))

    def toggle_running(self):
        enabling = not self.automation_enabled
        if enabling:
            amount_text = (self.pair_table.item(0, 2).text() if self.pair_table.item(0, 2) else "").strip()
            try:
                amount_value = float(amount_text)
                secondary_amount_value = float(self.auto_secondary_buy_amount)
                if (
                    not math.isfinite(amount_value)
                    or amount_value <= 0
                    or not math.isfinite(secondary_amount_value)
                    or secondary_amount_value <= 0
                ):
                    raise ValueError
            except ValueError:
                self.log.add("ERROR", "自动买入金额必须为大于 0 的 USDT 数值")
                return
            self.auto_buy_amount = amount_text
        self.automation_enabled = enabling
        self.store.set_setting("auto_buy_enabled", "1" if self.automation_enabled else "0")
        self.target_time = self.next_auto_scan_time()
        if self.automation_enabled:
            self.start_btn.setText("停止自动买入")
            pairs_text = ", ".join(f"{pair} {amount}U" for pair, amount in self.auto_pairs_for_run().items())
            strategy_text = "BNB 固定阶梯 + BTC/SOL/ETH SMART" if self.fixed_ladder_enabled else "BNB/BTC/SOL/ETH SMART 预测区间"
            self.log.add(
                "INFO",
                f"自动买入已启用：07:59:30 扫描；方案 {strategy_text}；启用 {pairs_text}",
            )
        else:
            self.start_btn.setText("启用自动买入")
            self.log.add("INFO", "自动买入已停止")

    def export_trades(self, kind: str):
        path, _ = QFileDialog.getSaveFileName(self, "导出成交记录", f"aoe-trades.{kind}", "CSV Files (*.csv)" if kind == "csv" else "Excel Files (*.xls)")
        if not path: return
        rows = self.store.conn.execute("SELECT * FROM executions ORDER BY ts DESC LIMIT 5000").fetchall(); headers = ["时间", "交易对", "成交金额", "成交价格", "Gas", "签名耗时", "广播耗时", "确认耗时", "总耗时", "TX Hash", "状态", "收益"]; keys = ["ts", "pair", "amount_usdt", "price", "gas_usdt", "signature_ms", "broadcast_ms", "confirmation_ms", "total_ms", "tx_hash", "status", "profit_usdt"]
        if kind == "csv":
            with open(path, "w", newline="", encoding="utf-8-sig") as file:
                writer = csv.writer(file); writer.writerow(headers)
                for row in rows: writer.writerow([row[key] for key in keys])
        else:
            xml_rows = ["<tr>" + "".join(f"<td>{h}</td>" for h in headers) + "</tr>"]
            for row in rows: xml_rows.append("<tr>" + "".join(f"<td>{row[key] or ''}</td>" for key in keys) + "</tr>")
            Path(path).write_text("<html><head><meta charset='utf-8'></head><body><table>" + "".join(xml_rows) + "</table></body></html>", encoding="utf-8")
        self.log.add("SUCCESS", f"成交记录已导出：{path}")

    def export_predictor_log(self):
        path, _ = QFileDialog.getSaveFileName(self, "导出预测日志", "volume-predictor-log.csv", "CSV Files (*.csv)")
        if not path:
            return
        rows = self.store.conn.execute("SELECT * FROM volume_predictor_logs ORDER BY ts ASC").fetchall()
        headers = [
            "ts", "symbol", "current_volume", "elapsed_pct", "remaining_seconds", "speed_1h",
            "speed_4h", "speed_12h", "avg_speed", "predicted_volume", "lower_volume",
            "upper_volume", "current_range", "predicted_range", "target_range", "confidence",
            "event_message",
        ]
        with open(path, "w", newline="", encoding="utf-8-sig") as file:
            writer = csv.writer(file)
            writer.writerow(headers)
            for row in rows:
                writer.writerow([row[key] for key in headers])
        self.log.add("SUCCESS", f"预测日志已导出：{path}")

    def closeEvent(self, event):
        if self.auto_process and self.auto_process.state() != QProcess.NotRunning:
            self.auto_process.terminate()
            self.auto_process.waitForFinished(1000)
        self.network_executor.shutdown(wait=False, cancel_futures=True)
        super().closeEvent(event)

def apply_style(app: QApplication):
    app.setStyleSheet(
        """
        QWidget {
          background: #080b10;
          color: #d8e0ea;
          font-family: "Segoe UI", "Microsoft YaHei UI";
          font-size: 12px;
        }
        QFrame#Card {
          background: #101720;
          border: 1px solid #1b2734;
          border-radius: 8px;
        }
        QLabel#Muted { color: #6f8094; font-size: 11px; }
        QLabel#KpiValue { color: #eff6ff; font-size: 18px; font-weight: 700; }
        QLabel#PanelTitle { color: #edf4ff; font-size: 14px; font-weight: 700; }
        QLabel#Countdown { color: #f2f7ff; font-size: 72px; font-weight: 800; }
        QLabel#Mono { color: #9fb0c3; font-family: Consolas, "Cascadia Mono"; }
        QLabel#StatusLight { color: #708195; font-weight: 700; }
        QLabel#StatusLight[active="true"] { color: #23c483; }
        QLabel#CloseAlert { color: #23c483; font-weight: 700; padding: 4px 8px; }
        QLabel#CloseAlert[urgency="warning"] { color: #f59e0b; background: #2b2110; border-radius: 4px; }
        QLabel#CloseAlert[urgency="critical"] { color: #ef4444; background: #301315; border-radius: 4px; }
        QLabel#RangeBadge {
          color: #9fb0c3;
          background: #0b1118;
          border: 1px solid #27384a;
          border-radius: 5px;
          padding: 6px 12px;
        }
        QLabel#RangeBadge[active="true"] {
          color: #23c483;
          border-color: #23c483;
          background: #10241e;
          font-weight: 700;
        }
        QLineEdit, QSpinBox, QComboBox, QTextEdit {
          background: #080d13;
          border: 1px solid #27384a;
          border-radius: 6px;
          padding: 6px;
          selection-background-color: #3b82f6;
        }
        QPushButton {
          background: #111a24;
          border: 1px solid #27384a;
          border-radius: 6px;
          padding: 7px 11px;
          color: #c7d3e2;
          font-weight: 650;
        }
        QPushButton:hover { border-color: #3b82f6; background: #142033; }
        QTableView {
          background: #0b1118;
          alternate-background-color: #0e151e;
          border: 1px solid #1a2634;
          border-radius: 7px;
          gridline-color: #172231;
        }
        QHeaderView::section {
          background: #0e151e;
          color: #7b8da3;
          border: 0;
          border-bottom: 1px solid #1a2634;
          padding: 8px;
          font-weight: 700;
        }
        QScrollBar:vertical, QScrollBar:horizontal { background: #080b10; width: 10px; height: 10px; }
        QScrollBar::handle { background: #263545; border-radius: 5px; }
        """
    )


def main():
    os.environ.setdefault("QT_ENABLE_HIGHDPI_SCALING", "1")
    os.environ.setdefault("QT_AUTO_SCREEN_SCALE_FACTOR", "1")
    app = QApplication(sys.argv)
    apply_style(app)
    window = MainWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
