import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey, Signer, Transaction, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";

import { Base, TokenAccount } from "../base";
import { findProgramAddress, forecastTransactionSize, getMultipleAccountsInfo } from "../common";
import { Token } from "../entity";
import { blob, publicKey, seq, struct, u64, u8 } from "../marshmallow";

export interface SHOW_INFO {
  programId: PublicKey,
  poolId: PublicKey,
  ammId: PublicKey,
  ownerAccountId: PublicKey,
  snapshotLpAmount: BN,

  openTime: number,
  endTime: number,

  canClaim: boolean,
  canClaimErrorType: canClaimErrorType

  tokenInfo: {
    mintAddress: PublicKey,
    mintVault: PublicKey,
    mintDecimals: number,
    perLpLoss: BN,
    debtAmount: BN
  }[]
}

export type canClaimErrorType = 'outOfOperationalTime' | 'alreadyClaimIt' | undefined

export class Utils1216 extends Base {
  static CLAIMED_NUM = 3
  static POOL_LAYOUT = struct([
    blob(8),
    u8('bump'),
    u8('status'),
    u64('openTime'),
    u64('endTime'),
    publicKey('ammId'),

    seq(struct([
      u8('mintDecimals'),
      publicKey('mintAddress'),
      publicKey('mintVault'),
      u64('perLpLoss'),
      u64('totalClaimedAmount'),
    ]), this.CLAIMED_NUM, "tokenInfo"),
    seq(u64(), 10, "padding"),
  ])
  static OWNER_LAYOUT = struct([
    blob(8),
    u8('bump'),
    u8('version'),
    publicKey('poolId'),
    publicKey('owner'),
    u64('lpAmount'),

    seq(struct([
      publicKey('mintAddress'),
      u64('debtAmount'),
      u64('claimedAmount'),
    ]), this.CLAIMED_NUM, "tokenInfo"),
    seq(u64(), 4, "padding"),
  ])
  static DEFAULT_POOL_ID = [
    '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
    '6UmmUiYoBjSrhakAobJw8BvkmJtDVxaeBtbt7rxWo1mg',
    'AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA',
    'DVa7Qmb5ct9RCpaU7UTpSaf3GVMYz17vNVU67XpdCRut',
    '7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX',
    '6a1CsrpeZubDjEJE9s1CMVheB6HWM5d7m1cj2jkhyXhj',
    'EoNrn8iUhwgJySD1pHu8Qxm5gSQqLK3za4m8xzD2RuEb',
    'AceAyRTWt4PyB2pHqf2qhDgNZDtKVNaxgL8Ru3V4aN1P',
    '6tmFJbMk5yVHFcFy7X2K8RwHjKLr6KVFLYXpgpBNeAxB',
  ].map(i => new PublicKey(i))

  static SEED_CONFIG = {
    pool: {
      id: Buffer.from('pool_seed', 'utf8'),
    },
    owner: {
      id: Buffer.from('user_claim_seed', 'utf8'),
    }
  }

  // pda
  static getPdaPoolId(programId: PublicKey, ammId: PublicKey) {
    return findProgramAddress([this.SEED_CONFIG.pool.id, ammId.toBuffer()], programId);
  }
  static getPdaOwnerId(programId: PublicKey, poolId: PublicKey, owner: PublicKey, version: number) {
    return findProgramAddress([
      this.SEED_CONFIG.owner.id, 
      poolId.toBuffer(), 
      owner.toBuffer(), 
      // new BN(version).toBuffer()
      Buffer.from(new BN(version).toArray())
    ], programId);
  }

  static async getAllInfo({
    connection,
    programId,
    poolIds,
    wallet,
    chainTime,
  }: {
    connection: Connection;
    programId: PublicKey,
    poolIds: PublicKey[],
    wallet: PublicKey,
    chainTime: number
  }) {
    if (poolIds.length === 0) return []

    const allPoolPda = poolIds.map(id => this.getPdaPoolId(programId, id).publicKey)
    const allOwnerPda = allPoolPda.map(id => this.getPdaOwnerId(programId, id, wallet, 0).publicKey)

    const pdaInfo = await getMultipleAccountsInfo(connection, [...allPoolPda, ...allOwnerPda])

    const info: SHOW_INFO[] = []
    for (let i = 0; i < poolIds.length; i++) {
      const itemPoolId = allPoolPda[i]
      const itemOwnerId = allOwnerPda[i]
      const itemPoolInfoS = pdaInfo[i]
      const itemOwnerInfoS = pdaInfo[poolIds.length + i]
      if (!(itemPoolInfoS && itemOwnerInfoS)) continue
      if (itemPoolInfoS.data.length !== this.POOL_LAYOUT.span || itemOwnerInfoS.data.length !== this.OWNER_LAYOUT.span) continue

      const itemPoolInfo = this.POOL_LAYOUT.decode(itemPoolInfoS.data)
      const itemOwnerInfo = this.OWNER_LAYOUT.decode(itemOwnerInfoS.data)

      const openTime = itemPoolInfo.openTime.toNumber()
      const endTime = itemPoolInfo.endTime.toNumber()

      const hasCanClaimToken = itemOwnerInfo.tokenInfo.map(i => i.debtAmount.gt(new BN(0))).filter(i => !i).length !== 3
      const inCanClaimTime = chainTime > openTime && chainTime < endTime && itemPoolInfo.status === 1

      const canClaim = hasCanClaimToken && inCanClaimTime

      info.push({
        programId,
        poolId: itemPoolId,
        ammId: itemPoolInfo.ammId,
        ownerAccountId: itemOwnerId,
        snapshotLpAmount: itemOwnerInfo.lpAmount,

        openTime,
        endTime,

        canClaim,
        canClaimErrorType: !hasCanClaimToken ? 'alreadyClaimIt' : !inCanClaimTime ? 'outOfOperationalTime' : undefined,

        tokenInfo: itemPoolInfo.tokenInfo.map((itemPoolToken, i) => ({
          mintAddress: itemPoolToken.mintAddress,
          mintVault: itemPoolToken.mintVault,
          mintDecimals: itemPoolToken.mintDecimals,
          perLpLoss: itemPoolToken.perLpLoss,
          debtAmount: itemOwnerInfo.tokenInfo[i].debtAmount.add(itemOwnerInfo.tokenInfo[i].claimedAmount)
        }))
      })
    }

    return info
  }

  static async makeClaimTransaction({ connection, poolInfo, ownerInfo }: {
    connection: Connection,
    poolInfo: SHOW_INFO,
    ownerInfo: {
      wallet: PublicKey,
      tokenAccounts: TokenAccount[],
      associatedOnly: boolean
    }
  }) {

    const frontInstructions: TransactionInstruction[] = [];
    const endInstructions: TransactionInstruction[] = [];
    const instructions: TransactionInstruction[] = [];

    const signers: Signer[] = []

    const ownerVaultList: PublicKey[] = []
    for (const itemToken of poolInfo.tokenInfo) {
      ownerVaultList.push((await this._selectOrCreateTokenAccount({
        mint: itemToken.mintAddress,
        tokenAccounts: itemToken.mintAddress.equals(Token.WSOL.mint) ? [] : ownerInfo.tokenAccounts,
        owner: ownerInfo.wallet,
  
        createInfo: {
          connection,
          payer: ownerInfo.wallet,
          amount: 0,
  
          frontInstructions,
          endInstructions: itemToken.mintAddress.equals(Token.WSOL.mint) ? endInstructions : [],
          signers
        },
  
        associatedOnly: itemToken.mintAddress.equals(Token.WSOL.mint) ? false : ownerInfo.associatedOnly
      }))!)
    }

    instructions.push(this.makeClaimInstruction({
      programId: poolInfo.programId,
      poolInfo,
      ownerInfo: {
        wallet: ownerInfo.wallet,
        ownerPda: poolInfo.ownerAccountId,
        claimAddress: ownerVaultList
      }
    }))

    return [
      { transaction: new Transaction().add(...frontInstructions, ...instructions, ...endInstructions), signer: signers },
    ]
  }

  static async makeClaimAllTransaction({ connection, poolInfos, ownerInfo }: {
    connection: Connection,
    poolInfos: SHOW_INFO[],
    ownerInfo: {
      wallet: PublicKey,
      tokenAccounts: TokenAccount[],
      associatedOnly: boolean
    }
  }) {
    
    const frontInstructions: TransactionInstruction[] = [];
    const endInstructions: TransactionInstruction[] = [];
    const instructions: TransactionInstruction[] = [];

    const signers: Signer[] = []

    const tempNewVault: {[mint: string]: PublicKey} = {}

    for (const poolInfo of poolInfos) {
      const ownerVaultList: PublicKey[] = []
      for (const itemToken of poolInfo.tokenInfo) {
        const tempVault = tempNewVault[itemToken.mintAddress.toString()] ?? await this._selectOrCreateTokenAccount({
          mint: itemToken.mintAddress,
          tokenAccounts: itemToken.mintAddress.equals(Token.WSOL.mint) ? [] : ownerInfo.tokenAccounts,
          owner: ownerInfo.wallet,
    
          createInfo: {
            connection,
            payer: ownerInfo.wallet,
            amount: 0,
    
            frontInstructions,
            endInstructions: itemToken.mintAddress.equals(Token.WSOL.mint) ? endInstructions : [],
            signers
          },
    
          associatedOnly: itemToken.mintAddress.equals(Token.WSOL.mint) ? false : ownerInfo.associatedOnly
        })
        tempNewVault[itemToken.mintAddress.toString()] = tempVault
        ownerVaultList.push(tempVault)
      }
  
      instructions.push(this.makeClaimInstruction({
        programId: poolInfo.programId,
        poolInfo,
        ownerInfo: {
          wallet: ownerInfo.wallet,
          ownerPda: poolInfo.ownerAccountId,
          claimAddress: ownerVaultList
        }
      }))
    }

    if (forecastTransactionSize([...frontInstructions, ...instructions, ...endInstructions], [ownerInfo.wallet, ...signers.map(i => i.publicKey)])) {
      return [
        { transaction: new Transaction().add(...frontInstructions, ...instructions, ...endInstructions), signer: signers },
      ]
    } else {
      return [
        { transaction: new Transaction().add(...frontInstructions), signer: signers },
        { transaction: new Transaction().add(...instructions), signer: [] },
        { transaction: new Transaction().add(...endInstructions), signer: [] },
      ]
    }
  }

  static makeClaimInstruction({programId, poolInfo, ownerInfo}: {
    programId: PublicKey,

    poolInfo: SHOW_INFO
    ownerInfo: {
      wallet: PublicKey,
      ownerPda: PublicKey,
      claimAddress: PublicKey[]
    }
  }) {
    const dataLayout = struct([ ]);
  
    const keys = [
      { pubkey: ownerInfo.wallet, isSigner: true, isWritable: true },
      { pubkey: poolInfo.poolId, isSigner: false, isWritable: true },
      { pubkey: ownerInfo.ownerPda, isSigner: false, isWritable: true },
  
      ...ownerInfo.claimAddress.map(i => ({ pubkey: i, isSigner: false, isWritable: true })),
      ...poolInfo.tokenInfo.map(({ mintVault }) => ({ pubkey: mintVault, isSigner: false, isWritable: true })),
  
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
  
    const data = Buffer.alloc(dataLayout.span);
    dataLayout.encode( { }, data );
    const aData = Buffer.from([...[10, 66, 208, 184, 161, 6, 191, 98], ...data]);
  
    return new TransactionInstruction({
      keys,
      programId,
      data: aData,
    });
  }
}