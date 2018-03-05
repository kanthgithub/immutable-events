import {provider as Provider, Wallet, Contract} from 'ethers';
import * as VError from 'verror';
import * as logger from 'config-logger';
import {readFileSync} from 'fs';
import BN from 'bn.js';

import {KeyStore} from './keyStore/index.d';

export interface SendOptions {
    gasLimit?: number,
    gasPrice?: number,
    value?: string
}

export declare interface TransactionReceipt {
    contractAddress?: string,
    transactionIndex: number,
    root?: string,
    status?: BN,
    gasUsed: BN,
    cumulativeGasUsed: BN,
    logsBloom: string,
    blockHash: string,
    transactionHash: string,
    logs: TransactionReceiptLog[],
    blockNumber: number
}

export declare interface TransactionReceiptLog {
    blockNumber: number,
    blockHash: string,
    transactionHash: string,
    transactionIndex: number,
    transactionLogIndex: number,
    address: string,
    topics: string[],
    data: string,
    logIndex: number
}

export default class BaseContract
{
    contract: object;
    contractOwner: string;

    constructor(protected transactionsProvider: Provider, protected eventsProvider: Provider,
                protected keyStore: KeyStore,
                protected jsonInterface: object[], protected contractBinary?: string,
                contractAddress?: string,
                protected defaultSendOptions: SendOptions = {
                    gasPrice: 1000000000,
                    gasLimit: 1200000})
    {
        if (contractAddress)
        {
            this.contract = new Contract(contractAddress, jsonInterface, this.transactionsProvider);
        }
    }

    // deploy a new contract
    deployContract(contractOwner: string, overrideSendOptions?: SendOptions, ...contractConstructorParams: any[]): Promise<TransactionReceipt>
    {
        // override the default send options
        const sendOptions = Object.assign({}, this.defaultSendOptions, overrideSendOptions);

        const description = `deploy contract with params ${contractConstructorParams.toString()}, from sender address ${contractOwner}, gas limit ${sendOptions.gasLimit} and gas price ${sendOptions.gasPrice}.`;

        return new Promise<TransactionReceipt>(async (resolve, reject) =>
        {
            logger.debug(`About to ${description}`);

            if (!this.contractBinary) {
                const error = new VError(`Binary for smart contract has not been set so can not ${description}.`);
                logger.error(error.stack);
                return reject(error);
            }

            try
            {
                this.contractOwner = contractOwner;

                const deployTransactionData = Contract.getDeployTransaction(this.contractBinary, this.jsonInterface, ...contractConstructorParams);

                const privateKey = await this.keyStore.getPrivateKey(contractOwner);

                const wallet = new Wallet(privateKey, this.transactionsProvider);

                const deployTransaction = Object.assign(deployTransactionData, sendOptions);

                // Send the transaction
                const broadcastTransaction = await wallet.sendTransaction(deployTransaction);

                logger.debug(`${broadcastTransaction.hash} is transaction hash for ${description}`);

                const transactionReceipt = await this.processTransaction(broadcastTransaction.hash, description, deployTransaction.gasLimit);

                this.contract = new Contract(transactionReceipt.contractAddress, this.jsonInterface, wallet);

                logger.info(`${this.contract.address} created from ${description}`);

                resolve(transactionReceipt);
            }
            catch (err)
            {
                const error = new VError(err, `Failed to ${description}.`);
                logger.error(error.stack);
                reject(error);
            }
        });
    }

    async call(functionName: string, ...callParams: any[]): Promise<any>
    {
        const description = `calling function ${functionName} with params ${callParams.toString()} on contract with address ${this.contract.address}`;

        try
        {
            let result = await this.contract[functionName](...callParams);

            // if an Ethers BigNumber
            if (result._bn)
            {
                // convert to a bn.js BigNumber
                result = result._bn;
            }

            logger.info(`Got ${result} from ${description}`);
            return result;
        }
        catch (err)
        {
            const error = new VError(err, `Could not get ${description}`);
            logger.error(error.stack);
            throw error;
        }
    }

    async send(functionName: string, txSignerAddress: string, overrideSendOptions?: SendOptions, ...callParams: any[]): Promise<TransactionReceipt>
    {
        // override the default send options
        const sendOptions = Object.assign({}, this.defaultSendOptions, overrideSendOptions);

        const description = `send transaction to function ${functionName} with parameters ${JSON.stringify(callParams)}, gas limit ${sendOptions.gasLimit} and gas price ${sendOptions.gasPrice} on contract with address ${this.contract.address}`;

        return new Promise<TransactionReceipt>(async (resolve, reject) =>
        {
            try
            {
                let contract: Contract = this.contract;

                if (txSignerAddress)
                {
                    const privateKey = await this.keyStore.getPrivateKey(txSignerAddress);
                    const wallet = new Wallet(privateKey, this.transactionsProvider);
                    contract = new Contract(this.contract.address, this.jsonInterface, wallet);
                }

                // send the transaction
                const broadcastTransaction = await contract[functionName](...callParams, sendOptions);

                logger.debug(`${broadcastTransaction.hash} is transaction hash and nonce ${broadcastTransaction.nonce} for ${description}`);

                const transactionReceipt = await this.processTransaction(broadcastTransaction.hash, description, sendOptions.gasLimit);

                resolve(transactionReceipt);
            }
            catch (err) {
                const error = new VError(err, `Failed to ${description}.`);
                logger.error(error.stack);
                reject(error);
            }
        });
    }

    async processTransaction(hash: string, description: string, gasLimit: number): Promise<TransactionReceipt>
    {
        // wait for the transaction to be mined
        const minedTransaction = await this.transactionsProvider.waitForTransaction(hash);

        logger.debug(`${hash} mined in block number ${minedTransaction.blockNumber} for ${description}`);

        const rawTransactionReceipt: TransactionReceipt = await this.transactionsProvider.getTransactionReceipt(hash);

        const transactionReceipt = BaseContract.convertEthersBNs(rawTransactionReceipt) as TransactionReceipt;

        logger.debug(`Status ${transactionReceipt.status} and ${transactionReceipt.gasUsed} gas of ${gasLimit} used for ${description}`);

        // If a status of 0 was returned then the transaction failed. Status 1 means the transaction worked
        if (transactionReceipt.status == 0) {
            throw VError(`Failed transaction ${hash} with status code ${transactionReceipt.status}. ${transactionReceipt.gasUsed} gas used of ${gasLimit} gas limit.`);
        }

        return transactionReceipt;
    }

    static convertEthersBNs(object: object): object
    {
        const result = {};

        for (let key of Object.keys(object))
        {
            const value: any = object[key];

            if (typeof(value) == 'object' && value != null && value.hasOwnProperty("_bn"))
            {
                result[key] = value._bn;
            }
            else {
                result[key] = value;
            }
        }

        return result;
    }

    async getEvents(eventName: string, fromBlock: number = 0): Promise<object[]>
    {
        const description = `${eventName} events from block ${fromBlock} and contract address ${this.contract.address}`;

        const options = {
            fromBlock: fromBlock
        };

        try
        {
            logger.debug(`About to get ${description}`);

            if (!this.contract.interface.events[eventName]) {
                throw new VError(`event name ${eventName} does not exist on the contract interface`);
            }

            const Event = this.contract.interface.events[eventName];

            const logs = await this.eventsProvider.getLogs({
                fromBlock: fromBlock,
                toBlock: "latest",
                address: this.contract.address,
                topics: Event.topics
            });

            const events: object[] = [];

            for (const log of logs)
            {
                const event = Event.parse(log.topics, log.data);

                // convert any Ethers.js BigNumber types to BN
                const convertedEvent = BaseContract.convertEthersBNs(event);

                events.push(convertedEvent);
            }

            logger.debug(`${events.length} events successfully returned from ${description}`);

            return events;
        }
        catch (err)
        {
            const error = new VError(err, `Could not get ${description}`);
            console.log(error.stack);
            throw error;
        }
    }

    static loadJsonInterfaceFromFile(filename: string): object[]
    {
        const jsonInterfaceStr = readFileSync(filename + ".abi", 'utf8');
        return JSON.parse(jsonInterfaceStr);
    }

    static loadBinaryFromFile(filename: string): string
    {
        return '0x' + readFileSync(filename + ".bin", 'utf8');
    }
}