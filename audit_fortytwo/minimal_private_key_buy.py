import os
from decimal import Decimal

from eth_abi import encode
from web3 import Web3

RPC = os.getenv("BSC_RPC_URL", "https://bsc-dataseed.bnbchain.org")
PK = os.environ["PRIVATE_KEY"]
MARKET = Web3.to_checksum_address(os.getenv("MARKET_ADDRESS", "0xfFb5Ce7060E6CE733EaBcb984dA7B47a721184bd"))
TOKEN_ID = int(os.getenv("TOKEN_ID", "4"))
AMOUNT = int(Decimal(os.getenv("AMOUNT_USDT", "10")) * Decimal(10**18))
ROUTER = Web3.to_checksum_address("0x888888886619275d33c00D3BC62DF94D700DCD42")
LENS = Web3.to_checksum_address("0x4AAd5A856941FB64df10362024e3Ece24023d4d1")
USDT = Web3.to_checksum_address("0x55d398326f99059fF775485246999027B3197955")
INTEGRATOR = Web3.to_checksum_address("0xc60E3415648684b1D0D0D97e85CB21E6a2bCb620")

w3 = Web3(Web3.HTTPProvider(RPC))
acct = w3.eth.account.from_key(PK)
erc20 = w3.eth.contract(address=USDT, abi=[
    {"type": "function", "name": "approve", "inputs": [{"type": "address"}, {"type": "uint256"}], "outputs": [{"type": "bool"}]},
    {"type": "function", "name": "allowance", "inputs": [{"type": "address"}, {"type": "address"}], "outputs": [{"type": "uint256"}]},
])
lens = w3.eth.contract(address=LENS, abi=[{
    "type": "function", "name": "simulateMint",
    "inputs": [{"type": "address"}, {"type": "uint256"}, {"type": "uint256"}, {"type": "bool"}, {"type": "bytes"}, {"type": "bytes"}, {"type": "uint256"}],
    "outputs": [
        {"type": "tuple", "components": [{"type": "uint256"}, {"type": "uint256"}, {"type": "uint256"}, {"type": "uint256"}, {"type": "uint256"}]},
        {"type": "tuple", "components": [{"type": "uint256"}, {"type": "uint256"}, {"type": "uint256"}, {"type": "uint256"}, {"type": "uint256"}]},
        {"type": "tuple", "components": [{"type": "uint256"}, {"type": "uint256"}, {"type": "uint256"}, {"type": "uint256"}]},
    ],
}])
router = w3.eth.contract(address=ROUTER, abi=[{
    "type": "function", "name": "swap",
    "inputs": [
        {"type": "address"}, {"type": "address"}, {"type": "uint256"},
        {"type": "tuple", "components": [{"type": "bool"}, {"type": "uint256"}, {"type": "bool"}, {"type": "uint256"}]},
        {"type": "bytes"}, {"type": "bytes"}, {"type": "address"}, {"type": "uint256"},
    ],
    "outputs": [],
}])


def send(tx):
    tx.update({"from": acct.address, "chainId": 56, "nonce": w3.eth.get_transaction_count(acct.address), "gasPrice": w3.eth.gas_price})
    tx["gas"] = int(w3.eth.estimate_gas(tx) * 1.2)
    signed = acct.sign_transaction(tx)
    raw = getattr(signed, "rawTransaction", None) or signed.raw_transaction
    return w3.eth.send_raw_transaction(raw).hex()


if erc20.functions.allowance(acct.address, ROUTER).call() < AMOUNT:
    approve_hash = send(erc20.functions.approve(ROUTER, 2**256 - 1).build_transaction())
    print(approve_hash)
    w3.eth.wait_for_transaction_receipt(approve_hash)

guess0 = encode(["uint256", "uint256", "uint256"], [0, 100, 10**15])
quote = lens.functions.simulateMint(MARKET, TOKEN_ID, AMOUNT, True, b"", guess0, 40).call({"from": acct.address})[2]
min_out = int(quote[3]) * 98 // 100
guess1 = encode(["uint256", "uint256", "uint256"], [int(quote[3]), 50, 10**15])
swap_hash = send(router.functions.swap(MARKET, acct.address, TOKEN_ID, (True, AMOUNT, True, min_out), b"", guess1, INTEGRATOR, 40).build_transaction())
print(swap_hash)
