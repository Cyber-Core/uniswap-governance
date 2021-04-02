import chai, { expect } from 'chai'
import { BigNumber, Contract, constants, utils } from 'ethers'
import { providers, Wallet} from 'ethers'

import { solidity, MockProvider, createFixtureLoader, deployContract } from 'ethereum-waffle'
import { ecsign } from 'ethereumjs-util'

import { governanceFixture } from './fixtures'
import { expandTo18Decimals, mineBlock } from './utils'

import Uni from '../build/Uni.json'

chai.use(solidity)

const DOMAIN_TYPEHASH = utils.keccak256(
  utils.toUtf8Bytes('EIP712Domain(string name,uint256 chainId,address verifyingContract)')
)

const PERMIT_TYPEHASH = utils.keccak256(
  utils.toUtf8Bytes('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)')
)

describe('Uni', () => {
  // const provider = new MockProvider({
  //   ganacheOptions: {
  //     hardfork: 'istanbul',
  //     mnemonic: 'horn horn horn horn horn horn horn horn horn horn horn horn',
  //     gasLimit: 9999999,
  //   },
  // })
  // const [wallet, other0, other1] = provider.getWallets()
  const provider = new providers.JsonRpcProvider("http://127.0.0.1:9090/solana", {chainId:111, name:""});
  const wallet = new Wallet("0x769c58f303b0fe8d4513df3dc086b0f18d8076d147384337a336d18b47e21591", provider)
  // const wallet = new Wallet("0xa45bb678781eaebed1eaca0921efb31aaf66677345d1f60bf1af63d105548ead", provider)
  const other0 = new Wallet("0x1c00007f45bac5bf39ff1749cef735b37445ba39bc6511a5c0ef6ac15e5e1bd7", provider)
  const other1 = new Wallet("0x7ff569f2cf9e76d03a53dc9784c212507064305494625b8f6ee7aed3562d6737", provider)
  // const loadFixture = createFixtureLoader([wallet], provider)

  let uni: Contract
  let time: Contract
  let gov: Contract
  beforeEach(async () => {

    const fixture = await governanceFixture([wallet], provider)
    uni = fixture.uni
    time = fixture.timelock
    gov = fixture.governorAlpha
  })

  it('deploy contracts', async () => {
    console.log("deploy Uni, Timelock, GovernorAlpha complete")
    console.log("Copy next lines to `update_contracts.sh` from uniswap-interface.git repository")
    console.log("--------------- START OF COPIED LINES -----------------")
    console.log("update_address UNI_ADDRESS", uni.address)
    console.log("update_address TIMELOCK_ADDRESS", time.address)
    console.log("update_address GOVERNANCE_ADDRESS", gov.address)
    console.log("---------------- END OF COPIED LINES ------------------")
  })

  it('permit', async () => {
    const domainSeparator = utils.keccak256(
      utils.defaultAbiCoder.encode(
        ['bytes32', 'bytes32', 'uint256', 'address'],
        [DOMAIN_TYPEHASH, utils.keccak256(utils.toUtf8Bytes('Uniswap')), 1, uni.address]
      )
    )

    const owner = wallet.address
    const spender = other0.address
    const value = 123
    const nonce = await uni.nonces(wallet.address)
    const deadline = constants.MaxUint256
    const digest = utils.keccak256(
      utils.solidityPack(
        ['bytes1', 'bytes1', 'bytes32', 'bytes32'],
        [
          '0x19',
          '0x01',
          domainSeparator,
          utils.keccak256(
            utils.defaultAbiCoder.encode(
              ['bytes32', 'address', 'address', 'uint256', 'uint256', 'uint256'],
              [PERMIT_TYPEHASH, owner, spender, value, nonce, deadline]
            )
          ),
        ]
      )
    )

    const { v, r, s } = ecsign(Buffer.from(digest.slice(2), 'hex'), Buffer.from(wallet.privateKey.slice(2), 'hex'))

    await uni.permit(owner, spender, value, deadline, v, utils.hexlify(r), utils.hexlify(s))
    expect(await uni.allowance(owner, spender)).to.eq(value)
    expect(await uni.nonces(owner)).to.eq(1)

    await uni.connect(other0).transferFrom(owner, spender, value)
  })

  it('nested delegation', async () => {
    await uni.transfer(other0.address, expandTo18Decimals(1))
    await uni.transfer(other1.address, expandTo18Decimals(2))

    let currectVotes0 = await uni.getCurrentVotes(other0.address)
    let currectVotes1 = await uni.getCurrentVotes(other1.address)
    expect(currectVotes0).to.be.eq(0)
    expect(currectVotes1).to.be.eq(0)

    await uni.connect(other0).delegate(other1.address)
    currectVotes1 = await uni.getCurrentVotes(other1.address)
    expect(currectVotes1).to.be.eq(expandTo18Decimals(1))

    await uni.connect(other1).delegate(other1.address)
    currectVotes1 = await uni.getCurrentVotes(other1.address)
    expect(currectVotes1).to.be.eq(expandTo18Decimals(1).add(expandTo18Decimals(2)))

    await uni.connect(other1).delegate(wallet.address)
    currectVotes1 = await uni.getCurrentVotes(other1.address)
    expect(currectVotes1).to.be.eq(expandTo18Decimals(1))
  })

  it('mints', async () => {
    const { timestamp: now } = await provider.getBlock('latest')
    const uni = await deployContract(wallet, Uni, [wallet.address, wallet.address, now + 60 * 60])
    const supply = await uni.totalSupply()

    await expect(uni.mint(wallet.address, 1)).to.be.revertedWith('Uni::mint: minting not allowed yet')

    let timestamp = await uni.mintingAllowedAfter()
    // await mineBlock(provider, timestamp.toString())

    await expect(uni.connect(other1).mint(other1.address, 1)).to.be.revertedWith('Uni::mint: only the minter can mint')
    await expect(uni.mint('0x0000000000000000000000000000000000000000', 1)).to.be.revertedWith('Uni::mint: cannot transfer to the zero address')

    // can mint up to 2%
    const mintCap = BigNumber.from(await uni.mintCap())
    const amount = supply.mul(mintCap).div(100)
    await uni.mint(wallet.address, amount)
    expect(await uni.balanceOf(wallet.address)).to.be.eq(supply.add(amount))

    timestamp = await uni.mintingAllowedAfter()
    // await mineBlock(provider, timestamp.toString())
    // cannot mint 2.01%
    await expect(uni.mint(wallet.address, supply.mul(mintCap.add(1)))).to.be.revertedWith('Uni::mint: exceeded mint cap')
  })
})
