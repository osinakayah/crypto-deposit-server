import { Injectable, Logger } from '@nestjs/common';
import { Client } from '@liquality/client';
import { BitcoinRpcProvider } from '@liquality/bitcoin-rpc-provider';
import { BitcoinNetworks } from '@liquality/bitcoin-networks';
import { InjectModel } from '@nestjs/mongoose';
import { CryptoDepositDto } from '../dtos/crypto.deposit.dto';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { Address, AddressDocument } from '../address/schema/address.schema';
import { Asset, AssetDocument } from '../asset/schemas/asset.schema';
import { Deposit, DepositDocument } from '../address/schema/deposit.schema';
import { Block, BlockDocument } from '../block-scheduler/schema/block.schema';

@Injectable()
export class BitcoinService {
  btcClient = new Client();
  private readonly logger = new Logger(BitcoinService.name);
  constructor(
    @InjectModel(Address.name)
    private addressDocumentModel: Model<AddressDocument>,
    @InjectModel(Asset.name) private assetDocumentModel: Model<AssetDocument>,
    private configService: ConfigService,
    @InjectModel(Deposit.name)
    private depositDocumentModel: Model<DepositDocument>,
    @InjectModel(Block.name) private blockDocumentModel: Model<BlockDocument>,
  ) {
    this.btcClient.addProvider(
      new BitcoinRpcProvider({
        uri: this.configService.get('BTC_RPC_URL'),
        feeBlockConfirmations: 2,
        network: BitcoinNetworks.bitcoin_testnet,
      }),
    );
  }
  getCurrentBlockHeight() {
    return this.btcClient.chain.getBlockHeight();
  }
  private async getAmountDeposited(
    hash: string,
    vout: Array<any>,
  ): Promise<CryptoDepositDto> {
    if (Array.isArray(vout)) {
      for (let i = 0; i < vout.length; i++) {
        const singleVOut = vout[i];
        if (singleVOut.scriptPubKey?.address) {
          const address: string = singleVOut.scriptPubKey?.address;

          const asset = await this.assetDocumentModel.findOne({
            code: 'BTC',
            chain: 'bitcoin',
            type: 'native',
          });

          const addressDocument = await this.addressDocumentModel.findOne({
            address,
            asset,
          });

          if (addressDocument) {
            return {
              amount: singleVOut.value,
              address: addressDocument,
              txHash: hash,
            };
          }
        }
      }
    }
    return {
      amount: 0,
      address: null,
      txHash: hash,
    };
  }

  private getTransactionByHash(txHash) {
    return this.btcClient.getMethod('getParsedTransactionByHash')(txHash, true);
  }
  async scrapeBlock(blockNumber: number) {
    const blockData = await this.btcClient.chain.getBlockByNumber(
      blockNumber,
      false,
    );
    const transactionHashes: Array<string> = blockData.transactions.map(
      (tx) => tx,
    );

    const hashesLength = transactionHashes.length;

    for (let i = 0; i < hashesLength; i++) {
      const transaction = await this.getTransactionByHash(transactionHashes[i]);

      const cryptoDeposit = await this.getAmountDeposited(
        transaction.hash,
        transaction._raw.vout,
      );
      if (cryptoDeposit.amount > 0) {
        await this.broadcastDeposit(cryptoDeposit);
      }
      await this.blockDocumentModel.updateOne(
        {
          height: blockNumber,
          chain: 'bitcoin',
        },
        {
          hasCompletedScan: true,
        },
      );
    }
    //Complete block scraping
  }
  private async broadcastDeposit(cryptoDeposit: CryptoDepositDto) {
    const existingDeposit = await this.depositDocumentModel.findOne({
      txHash: cryptoDeposit.txHash,
    });
    if (!existingDeposit) {
      await this.depositDocumentModel.create({
        address: cryptoDeposit.address,
        amount: cryptoDeposit.amount,
        txHash: cryptoDeposit.txHash,
      });
    }
  }
}