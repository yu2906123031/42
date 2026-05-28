import json
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

import requests
from eth_abi import encode
from web3 import Web3


def load_dotenv(path: str = ".env") -> None:
    env_path = Path(path)
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


load_dotenv()


def env_str(key: str, default: str) -> str:
    return os.environ.get(key, default)


def env_int(key: str, default: int) -> int:
    return int(os.environ.get(key, str(default)))


def env_decimal(key: str, default: str) -> Decimal:
    return Decimal(os.environ.get(key, default))


OFFICIAL_BSC_RPC_URLS = (
    "https://bsc-dataseed.bnbchain.org",
    "https://bsc-dataseed-public.bnbchain.org",
    "https://bsc-dataseed.nariox.org",
    "https://bsc-dataseed.defibit.io",
    "https://bsc-dataseed.ninicoin.io",
)


@dataclass(frozen=True)
class Config:
    graphql_url: str = env_str("GRAPHQL_URL", "https://ft.42.space/v1/graphql")
    bsc_rpc_url: str = env_str("BSC_RPC_URL", "https://bsc-dataseed.bnbchain.org")
    bsc_rpc_urls: str = env_str("BSC_RPC_URLS", "")
    bundler_url: str = env_str(
        "ZERODEV_BUNDLER_URL",
        "https://rpc.zerodev.app/api/v3/81d8983c-a3ff-4521-8553-31ad0c4e2155/chain/56",
    )
    pimlico_url: str = env_str(
        "PIMLICO_RPC_URL",
        "https://api.pimlico.io/v2/56/rpc?apikey=pim_EoZgCEstSMGMb3zUYB2U85",
    )
    market_address: str = env_str(
        "MARKET_ADDRESS", "0xfFb5Ce7060E6CE733EaBcb984dA7B47a721184bd"
    )
    target_token_id: int = env_int("TARGET_TOKEN_ID", 4)
    buy_amount_usdt: Decimal = env_decimal("BUY_AMOUNT_USDT", "10")
    poll_ms: int = env_int("POLL_MS", 500)
    max_price: Decimal = env_decimal("MAX_PRICE", "0.0015")
    slippage_bps: int = env_int("SLIPPAGE_BPS", 200)
    smart_account_address: str = env_str("SMART_ACCOUNT_ADDRESS", "")
    entry_point: str = env_str("ENTRY_POINT_ADDRESS", "")
    signed_userop_json: str = env_str("SIGNED_USEROP_JSON", "")
    submit_signed_userop: bool = env_str("SUBMIT_SIGNED_USEROP", "NO") == "YES"
    collateral: str = "0x55d398326f99059ff775485246999027b3197955"
    router: str = "0x888888886619275d33c00D3BC62DF94D700DCD42"
    lens: str = "0x8aF85927Cb4deBE57C47DDE5cdb4665839f55a32"
    integrator: str = "0xc60E3415648684b1D0D0D97e85CB21E6a2bCb620"
    integrator_fee_bps: int = 40
    collateral_decimals: int = 18
    ot_decimals: int = 18


ERC20_ABI = [
    {
        "type": "function",
        "name": "allowance",
        "stateMutability": "view",
        "inputs": [
            {"name": "owner", "type": "address"},
            {"name": "spender", "type": "address"},
        ],
        "outputs": [{"type": "uint256"}],
    },
    {
        "type": "function",
        "name": "approve",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "spender", "type": "address"},
            {"name": "amount", "type": "uint256"},
        ],
        "outputs": [{"type": "bool"}],
    },
]

LENS_ABI = [
    {
        "type": "function",
        "name": "simulateMint",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "market", "type": "address"},
            {"name": "tokenId", "type": "uint256"},
            {"name": "amount", "type": "uint256"},
            {"name": "isExactIn", "type": "bool"},
            {"name": "dataSwap", "type": "bytes"},
            {"name": "dataGuess", "type": "bytes"},
            {"name": "integratorFeeBps", "type": "uint256"},
        ],
        "outputs": [
            {
                "name": "pre",
                "type": "tuple",
                "components": [
                    {"name": "tokenId", "type": "uint256"},
                    {"name": "price", "type": "uint256"},
                    {"name": "supply", "type": "uint256"},
                    {"name": "totalMarketCap", "type": "uint256"},
                    {"name": "payoutPerOt", "type": "uint256"},
                    {"name": "marketCap", "type": "uint256"},
                ],
            },
            {
                "name": "post",
                "type": "tuple",
                "components": [
                    {"name": "tokenId", "type": "uint256"},
                    {"name": "price", "type": "uint256"},
                    {"name": "supply", "type": "uint256"},
                    {"name": "totalMarketCap", "type": "uint256"},
                    {"name": "payoutPerOt", "type": "uint256"},
                    {"name": "marketCap", "type": "uint256"},
                ],
            },
            {
                "name": "quote",
                "type": "tuple",
                "components": [
                    {"name": "collateralFromUser", "type": "uint256"},
                    {"name": "collateralToTreasury", "type": "uint256"},
                    {"name": "collateralToIntegrator", "type": "uint256"},
                    {"name": "otToUser", "type": "uint256"},
                ],
            },
        ],
    }
]

ROUTER_ABI = [
    {
        "type": "function",
        "name": "swap",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "market", "type": "address"},
            {"name": "receiver", "type": "address"},
            {"name": "tokenId", "type": "uint256"},
            {
                "name": "params",
                "type": "tuple",
                "components": [
                    {"name": "isMint", "type": "bool"},
                    {"name": "amount", "type": "uint256"},
                    {"name": "isExactIn", "type": "bool"},
                    {"name": "minOutOrMaxIn", "type": "uint256"},
                ],
            },
            {"name": "dataSwap", "type": "bytes"},
            {"name": "dataGuess", "type": "bytes"},
            {"name": "integrator", "type": "address"},
            {"name": "integratorFeeBps", "type": "uint256"},
        ],
        "outputs": [],
    }
]

MARKET_QUERY = """
query GetMarket($marketAddress: String!) {
  home_market_list(where: { market_address: { _eq: $marketAddress } }, limit: 1) {
    market_address
    title
    status
    outcomes
  }
}
"""


def to_wei(amount: Decimal, decimals: int) -> int:
    return int(amount * (Decimal(10) ** decimals))


def from_wei(amount: int, decimals: int) -> Decimal:
    return Decimal(amount) / (Decimal(10) ** decimals)


def smart_sim_eps(amount: Decimal) -> int:
    if amount < Decimal(5):
        return 50_000_000_000_000_000
    if amount <= Decimal(1000):
        return 1_000_000_000_000_000
    return int((Decimal(1) / amount) * Decimal(10**18))


def smart_eps(amount: Decimal) -> int:
    if amount < Decimal(5):
        return 200_000_000_000_000_000
    if amount <= Decimal(3000):
        return 1_000_000_000_000_000
    return int((Decimal(1) / amount) * Decimal(10**18))


def encode_data_guess(ot_delta_guess: int, max_iterations: int, eps: int) -> bytes:
    return encode(
        ["uint256", "uint256", "uint256"],
        [ot_delta_guess, max_iterations, eps],
    )


def encode_contract_call(contract: Any, fn_name: str, args: list[Any]) -> str:
    if hasattr(contract, "encodeABI"):
        return contract.encodeABI(fn_name=fn_name, args=args)
    return contract.encode_abi(fn_name, args=args)


def rpc_candidates(config: Config) -> list[str]:
    configured = [url.strip() for url in config.bsc_rpc_urls.split(",") if url.strip()]
    return list(dict.fromkeys([config.bsc_rpc_url, *configured, *OFFICIAL_BSC_RPC_URLS]))


def probe_rpc(url: str) -> tuple[str, float]:
    started = time.perf_counter()
    response = requests.post(
        url,
        json={"jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": []},
        timeout=4,
    )
    response.raise_for_status()
    chain_id = response.json().get("result")
    if chain_id != "0x38":
        raise RuntimeError(f"unexpected chain {chain_id or 'unknown'}")
    return url, (time.perf_counter() - started) * 1000


def select_fastest_rpc(config: Config) -> str:
    candidates = rpc_candidates(config)
    successful: list[tuple[str, float]] = []
    with ThreadPoolExecutor(max_workers=len(candidates)) as executor:
        tasks = {executor.submit(probe_rpc, url): url for url in candidates}
        for task in as_completed(tasks):
            url = tasks[task]
            try:
                successful.append(task.result())
            except Exception as error:
                print(f"RPC unavailable: {url} ({error})")
    if not successful:
        raise RuntimeError("No available BSC RPC endpoint returned chainId 56.")
    successful.sort(key=lambda item: item[1])
    print(f"BSC RPC selected: {successful[0][0]} ({successful[0][1]:.0f}ms)")
    print("BSC RPC ranking:", ", ".join(f"{url} ({latency:.0f}ms)" for url, latency in successful))
    return successful[0][0]


class FortyTwoSmartAccountBot:
    def __init__(self, config: Config):
        self.config = config
        self.rpc_url = select_fastest_rpc(config)
        self.web3 = Web3(Web3.HTTPProvider(self.rpc_url))
        self.market = self.web3.to_checksum_address(config.market_address)
        self.collateral = self.web3.to_checksum_address(config.collateral)
        self.router = self.web3.to_checksum_address(config.router)
        self.lens = self.web3.to_checksum_address(config.lens)
        self.integrator = self.web3.to_checksum_address(config.integrator)
        self.lens_contract = self.web3.eth.contract(address=self.lens, abi=LENS_ABI)
        self.router_contract = self.web3.eth.contract(address=self.router, abi=ROUTER_ABI)
        self.erc20_contract = self.web3.eth.contract(address=self.collateral, abi=ERC20_ABI)

    def get_market(self) -> dict[str, Any]:
        response = requests.post(
            self.config.graphql_url,
            json={
                "query": MARKET_QUERY,
                "variables": {"marketAddress": self.config.market_address},
            },
            timeout=10,
        )
        response.raise_for_status()
        markets = response.json()["data"]["home_market_list"]
        if not markets:
            raise RuntimeError(f"Market not found: {self.config.market_address}")
        return markets[0]

    def find_target_outcome(self, market: dict[str, Any]) -> dict[str, Any]:
        for outcome in market.get("outcomes", []):
            if int(outcome["token_id"]) != self.config.target_token_id:
                continue
            text = f"{outcome.get('name', '')} {outcome.get('symbol', '')}"
            if "300M" in text and "450M" in text:
                return outcome
        raise RuntimeError("Target outcome not found or token_id changed")

    def wait_until_live(self) -> dict[str, Any]:
        while True:
            market = self.get_market()
            outcome = self.find_target_outcome(market)
            price = Decimal(str(outcome["price_hmr"]))
            print(f"status={market['status']} price={price} title={market['title']}")
            if price > self.config.max_price:
                raise RuntimeError(f"Abort: price {price} > MAX_PRICE {self.config.max_price}")
            if market["status"] == "live":
                return outcome
            time.sleep(self.config.poll_ms / 1000)

    def simulate_mint(self, amount_wei: int) -> dict[str, int]:
        sim_guess = encode_data_guess(
            0,
            100,
            smart_sim_eps(self.config.buy_amount_usdt),
        )
        result = self.lens_contract.functions.simulateMint(
            self.market,
            self.config.target_token_id,
            amount_wei,
            True,
            b"",
            sim_guess,
            self.config.integrator_fee_bps,
        ).call()
        quote = result[2]
        return {
            "collateralFromUser": int(quote[0]),
            "collateralToTreasury": int(quote[1]),
            "collateralToIntegrator": int(quote[2]),
            "otToUser": int(quote[3]),
        }

    def build_calls(self) -> list[dict[str, str]]:
        if not self.config.smart_account_address:
            raise RuntimeError("Set SMART_ACCOUNT_ADDRESS to the 42 smart account address")

        smart_account = self.web3.to_checksum_address(self.config.smart_account_address)
        amount_wei = to_wei(self.config.buy_amount_usdt, self.config.collateral_decimals)
        quote = self.simulate_mint(amount_wei)
        min_out = quote["otToUser"] * (10_000 - self.config.slippage_bps) // 10_000
        exec_guess = encode_data_guess(
            quote["otToUser"],
            50,
            smart_eps(self.config.buy_amount_usdt),
        )

        calls: list[dict[str, str]] = []
        allowance = self.erc20_contract.functions.allowance(smart_account, self.router).call()
        if allowance < amount_wei:
            approve_data = encode_contract_call(
                self.erc20_contract, "approve", [self.router, 2**256 - 1]
            )
            calls.append({"to": self.collateral, "data": approve_data, "value": "0x0"})

        swap_data = encode_contract_call(
            self.router_contract,
            "swap",
            [
                self.market,
                smart_account,
                self.config.target_token_id,
                (True, amount_wei, True, min_out),
                b"",
                exec_guess,
                self.integrator,
                self.config.integrator_fee_bps,
            ],
        )
        calls.append({"to": self.router, "data": swap_data, "value": "0x0"})

        print("simulated_ot_out=", from_wei(quote["otToUser"], self.config.ot_decimals))
        print("min_ot_out=", from_wei(min_out, self.config.ot_decimals))
        return calls

    def user_operation_payload_skeleton(self, calls: list[dict[str, str]]) -> dict[str, Any]:
        return {
            "kind": "zerodev_kernel_calls",
            "chainId": 56,
            "smartAccount": self.config.smart_account_address,
            "bundlerUrl": self.config.bundler_url,
            "paymasterUrl": self.config.pimlico_url,
            "paymasterContext": {"sponsorshipPolicyId": "sp_natural_sumo"},
            "calls": calls,
            "note": (
                "This is not a signed UserOperation. Use a legitimate Privy/ZeroDev "
                "owner signer to convert calls into a signed UserOperation."
            ),
        }

    def submit_signed_user_operation(self) -> None:
        if not self.config.entry_point:
            raise RuntimeError("Set ENTRY_POINT_ADDRESS before submitting a signed UserOperation")
        if not self.config.signed_userop_json:
            raise RuntimeError("Set SIGNED_USEROP_JSON to a signed UserOperation JSON string")
        userop = json.loads(self.config.signed_userop_json)
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_sendUserOperation",
            "params": [userop, self.config.entry_point],
        }
        response = requests.post(self.config.bundler_url, json=payload, timeout=30)
        response.raise_for_status()
        print(json.dumps(response.json(), indent=2))

    def run(self) -> None:
        self.wait_until_live()
        calls = self.build_calls()
        skeleton = self.user_operation_payload_skeleton(calls)
        print(json.dumps(skeleton, indent=2))

        if self.config.submit_signed_userop:
            self.submit_signed_user_operation()


def main() -> None:
    FortyTwoSmartAccountBot(Config()).run()


if __name__ == "__main__":
    main()
