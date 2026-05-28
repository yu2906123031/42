import os
from decimal import Decimal

from eth_abi import encode
from web3 import Web3


RPC_URL = os.getenv("BSC_RPC_URL", "https://bsc-dataseed.bnbchain.org")
PRIVATE_KEY = os.environ["PRIVATE_KEY"]

ROUTER = Web3.to_checksum_address("0x888888886619275d33c00D3BC62DF94D700DCD42")
LENS = Web3.to_checksum_address("0x4AAd5A856941FB64df10362024e3Ece24023d4d1")
USDT = Web3.to_checksum_address("0x55d398326f99059fF775485246999027B3197955")
MARKET = Web3.to_checksum_address(
    os.getenv("MARKET_ADDRESS", "0xfFb5Ce7060E6CE733EaBcb984dA7B47a721184bd")
)
TOKEN_ID = int(os.getenv("TOKEN_ID", "4"))
AMOUNT_USDT = Decimal(os.getenv("AMOUNT_USDT", "10"))
SLIPPAGE_BPS = int(os.getenv("SLIPPAGE_BPS", "200"))
INTEGRATOR = Web3.to_checksum_address(
    os.getenv("INTEGRATOR", "0xc60E3415648684b1D0D0D97e85CB21E6a2bCb620")
)
INTEGRATOR_FEE_BPS = int(os.getenv("INTEGRATOR_FEE_BPS", "40"))

ERC20_ABI = [
    {
        "type": "function",
        "name": "allowance",
        "stateMutability": "view",
        "inputs": [{"name": "owner", "type": "address"}, {"name": "spender", "type": "address"}],
        "outputs": [{"type": "uint256"}],
    },
    {
        "type": "function",
        "name": "approve",
        "stateMutability": "nonpayable",
        "inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}],
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
            {"name": "pre", "type": "tuple", "components": [
                {"name": "tokenId", "type": "uint256"},
                {"name": "price", "type": "uint256"},
                {"name": "supply", "type": "uint256"},
                {"name": "totalMarketCap", "type": "uint256"},
                {"name": "payoutPerOt", "type": "uint256"},
            ]},
            {"name": "post", "type": "tuple", "components": [
                {"name": "tokenId", "type": "uint256"},
                {"name": "price", "type": "uint256"},
                {"name": "supply", "type": "uint256"},
                {"name": "totalMarketCap", "type": "uint256"},
                {"name": "payoutPerOt", "type": "uint256"},
            ]},
            {"name": "quote", "type": "tuple", "components": [
                {"name": "collateralFromUser", "type": "uint256"},
                {"name": "collateralToTreasury", "type": "uint256"},
                {"name": "collateralToIntegrator", "type": "uint256"},
                {"name": "otToUser", "type": "uint256"},
            ]},
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


def encode_guess(ot_delta_guess: int, max_iterations: int, eps: int) -> bytes:
    return encode(["uint256", "uint256", "uint256"], [ot_delta_guess, max_iterations, eps])


def smart_sim_eps(amount: Decimal) -> int:
    if amount < Decimal("5"):
        return 50_000_000_000_000_000
    if amount <= Decimal("1000"):
        return 1_000_000_000_000_000
    return int((Decimal(1) / amount) * Decimal(10**18))


def smart_eps(amount: Decimal) -> int:
    if amount < Decimal("5"):
        return 200_000_000_000_000_000
    if amount <= Decimal("3000"):
        return 1_000_000_000_000_000
    return int((Decimal(1) / amount) * Decimal(10**18))


def send_tx(w3: Web3, account, tx: dict) -> str:
    tx.setdefault("from", account.address)
    tx.setdefault("chainId", 56)
    tx.setdefault("nonce", w3.eth.get_transaction_count(account.address))
    tx.setdefault("gasPrice", w3.eth.gas_price)
    tx.setdefault("gas", int(w3.eth.estimate_gas(tx) * 1.2))
    signed = account.sign_transaction(tx)
    raw = getattr(signed, "rawTransaction", None) or signed.raw_transaction
    tx_hash = w3.eth.send_raw_transaction(raw)
    return tx_hash.hex()


def main() -> None:
    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    account = w3.eth.account.from_key(PRIVATE_KEY)
    amount_wei = int(AMOUNT_USDT * Decimal(10**18))

    usdt = w3.eth.contract(address=USDT, abi=ERC20_ABI)
    lens = w3.eth.contract(address=LENS, abi=LENS_ABI)
    router = w3.eth.contract(address=ROUTER, abi=ROUTER_ABI)

    allowance = usdt.functions.allowance(account.address, ROUTER).call()
    if allowance < amount_wei:
        approve_tx = usdt.functions.approve(ROUTER, 2**256 - 1).build_transaction()
        approve_hash = send_tx(w3, account, approve_tx)
        print("approve:", approve_hash)
        w3.eth.wait_for_transaction_receipt(approve_hash)

    sim_guess = encode_guess(0, 100, smart_sim_eps(AMOUNT_USDT))
    _, _, quote = lens.functions.simulateMint(
        MARKET, TOKEN_ID, amount_wei, True, b"", sim_guess, INTEGRATOR_FEE_BPS
    ).call({"from": account.address})

    ot_to_user = int(quote[3])
    min_out = ot_to_user * (10_000 - SLIPPAGE_BPS) // 10_000
    exec_guess = encode_guess(ot_to_user, 50, smart_eps(AMOUNT_USDT))

    swap_tx = router.functions.swap(
        MARKET,
        account.address,
        TOKEN_ID,
        (True, amount_wei, True, min_out),
        b"",
        exec_guess,
        INTEGRATOR,
        INTEGRATOR_FEE_BPS,
    ).build_transaction()
    swap_hash = send_tx(w3, account, swap_tx)
    print("swap:", swap_hash)
    w3.eth.wait_for_transaction_receipt(swap_hash)


if __name__ == "__main__":
    main()
