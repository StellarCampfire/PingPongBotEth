import 'dotenv/config';
import { Contract, JsonRpcProvider, Wallet, EventLog } from 'ethers';
import * as fs from 'fs';
import * as winston from 'winston';

const COMMON_PING_EVENT_QUEUE: string = 'Common_Ping_Event_Queue';
const FORCE_PING_EVENT_QUEUE: string = 'Force_Ping_Event_Queue';

interface State {
    lastBlock: number;
}

class Configuration {
    private readonly _providerUrl: string;
    private readonly _contractAddress: string;
    private readonly _contractABI: readonly string[];
    private readonly _lastBlock: number;
    private readonly _defaultGasLimit: number;
    private readonly _stateFile: string;

    constructor(infuraApiKey: string) {
      if (!infuraApiKey) {
        throw new Error('INFURA_API_KEY is required');
      }
      this._providerUrl = `https://sepolia.infura.io/v3/${infuraApiKey}`;
      this._contractAddress = '0xa7f42ff7433cb268dd7d59be62b00c30ded28d3d';
      this._contractABI = [
        'event Ping()',
        'function pong(bytes32 _txHash) external'
      ] as const;
      this._lastBlock = 7979028;
      this._defaultGasLimit = 50000;
      this._stateFile = 'lastBlock.json';
    }
  
    get providerUrl(): string {
      return this._providerUrl;
    }
  
    get contractAddress(): string {
      return this._contractAddress;
    }
  
    get contractABI(): readonly string[] {
      return this._contractABI;
    }

    get lastBlock(): number {
        return this._lastBlock;
    }

    get defaultGasLimit(): number {
        return this._defaultGasLimit;
    }

    get stateFile(): string {
        return this._stateFile;
    }
}


class Queue<T extends EventLog> {
    queueName: string;
    queue: T[];
    gasModifier: number;
    lock: boolean;
  
    constructor(queueName: string, gasModifier: number) {
        this.queueName = queueName;
        this.queue = [];
        this.gasModifier = gasModifier;
        this.lock = false;
    }
  
    push(event: T): void {
        if (!this.queue.some(e => e.transactionHash === event.transactionHash)) {
            this.queue.push(event);
            logger.info(`Event on block ${event.blockNumber} was pushed into queue: ${this.queueName}`);
            return;
        }
        logger.warn(`Event on block ${event.blockNumber} was not pushed into queue: ${this.queueName}; Reason: duplicate.`);
    }
  
    shift(): T | undefined {
        return this.queue.shift();
    }
    
    getFirst(): T | undefined {
        return this.queue[0];
    }
  
    get length(): number {
        return this.queue.length;
    }
} 

// --------------------- BOT STATE --------------------- //
interface State {
    lastBlock: number;
    sentTransactions: { [txHash: string]: { blockNumber: number; } };
    failedTransactions: { [txHash: string]: { blockNumber: number; } };
}

interface IBotStateManager {
    getLastBlock(): number;
    setLastBlock(blockNumber: number): void;

    addSentTransaction(pingTxHash: string, blockNumber: number): void;
    addFailedTransaction(pingTxHash: string, blockNumber: number): void;
    
    getSentTransactions(): { [txHash: string]: { blockNumber: number; } }
    
    clearTransactionsBeforeBlock(blockNumber: number): void;
}

class BotStateManagerFS implements IBotStateManager {
    private readonly _stateFile: string;
    private _lastBlock: number;
    private _sentTransactions: { [txHash: string]: { blockNumber: number; } };
    private _failedTransactions: { [txHash: string]: { blockNumber: number; } };

    constructor(configuration: Configuration){
        this._lastBlock = configuration.lastBlock;
        this._sentTransactions = {};
        this._failedTransactions = {};
        this._stateFile = configuration.stateFile;

        if (fs.existsSync(this._stateFile)) {
            const data: State = JSON.parse(fs.readFileSync(this._stateFile, 'utf8'));
            if (data.lastBlock >= configuration.lastBlock)
                this._lastBlock = data.lastBlock;
            this._sentTransactions = data.sentTransactions || {};
            this._failedTransactions = data.failedTransactions || {};
        }
        this.saveState();
    }

    getLastBlock(): number {
        return this._lastBlock;
    }

    addSentTransaction(pingTxHash: string, blockNumber: number): void {
        this._sentTransactions[pingTxHash] = {
            blockNumber,
        };
        this.saveState();
    }

    addFailedTransaction(pingTxHash: string, blockNumber: number): void {
        this._failedTransactions[pingTxHash] = {
            blockNumber,
        };
        this.saveState();
    }

    clearTransactionsBeforeBlock(blockNumber: number): void {
        for (const txHash in this._sentTransactions) {
            if (this._sentTransactions[txHash].blockNumber < blockNumber) {
                delete this._sentTransactions[txHash];
            }
        }
        this.saveState();
    }

    setLastBlock(blockNumber: number): void {
        this._lastBlock = blockNumber;
        this.saveState();
    }

    private saveState(): void {
        const state: State = {
            lastBlock: this._lastBlock,
            sentTransactions: this._sentTransactions,
            failedTransactions: this._failedTransactions
        };
        fs.writeFileSync(this._stateFile, JSON.stringify(state, null, 2));
    }

    getSentTransactions(): { [txHash: string]: { blockNumber: number; } } {
        return this._sentTransactions;
    }
}


class Bot{
    provider : JsonRpcProvider;
    wallet : Wallet;
    contract : Contract;
    eventQueue : Queue<EventLog>;
    forceEventQueue : Queue<EventLog>;
    defaultGasLimit: number;
    botStateManager: IBotStateManager;

    constructor(
        configuration: Configuration, 
        eventQueue: Queue<EventLog>, 
        forceEventQueue: Queue<EventLog>, 
        botStateManager: IBotStateManager
    ){
        this.botStateManager = botStateManager;

        this.provider = new JsonRpcProvider(configuration.providerUrl);
        this.wallet = new Wallet(process.env.PRIVATE_KEY!, this.provider); // ! PRIVATE_KEY exists
        this.contract = new Contract(configuration.contractAddress, configuration.contractABI, this.wallet);
        this.defaultGasLimit = configuration.defaultGasLimit;

        this.eventQueue = eventQueue;
        this.forceEventQueue = forceEventQueue;

    }

    async init(){
        const lastBlock = this.botStateManager.getLastBlock();
        const currentBlock = await this.provider.getBlockNumber();
        logger.info(`Bot started with address ${this.wallet.address}, listening for Pings from block ${currentBlock}`);

        this.contract.on('Ping', async (event: EventLog) => {
            if (event.blockNumber > currentBlock) {
                logger.info(`Catching new Ping event on block: ${event.blockNumber}`);
                this.eventQueue.push(event);
            }
        });

        await this.catchMissedEventsFromTo(lastBlock, currentBlock);

        setInterval(() => this.queueHandle(this.eventQueue), 5000); // handle queue every 5s
        setInterval(() => this.queueHandle(this.forceEventQueue), 5000); // handle queue every 5s with no save state
        setInterval(async () => {
            const lastBlock = this.botStateManager.getLastBlock();
            const currentBlock = await this.provider.getBlockNumber();
            await bot.catchMissedEventsFromTo(lastBlock, currentBlock);
        }, 60000); // check missing events every minute and move last block.
    }

    async queueHandle(queue: Queue<EventLog>): Promise<void> {
        if (queue.lock) return;
    
        queue.lock = true;
        const event = queue.shift();
        // if queue is empty this check needs to make under lock 
        if (!event) {
            queue.lock = false;
            return;
        }

        logger.info(`Queue: ${queue.queueName} length: ${queue.length}, processing event: ${event.transactionHash} (block ${event.blockNumber})`);
        try {
            await this.sendPong(event, this.defaultGasLimit * queue.gasModifier);
        } catch (error) {
            console.log(`Error sending pong for tx ${event.transactionHash}: ${(error as Error).message} Retrying later`); 
            this.handleErrorPong(event, queue);
        } finally {
            queue.lock = false;
        }
    }

    async handleErrorPong(event: EventLog, queue: Queue<EventLog>){
        switch (queue.queueName) {
            // If transaction failed move event in force queue to try to send it with more gas
            case COMMON_PING_EVENT_QUEUE:
                this.forceEventQueue.push(event);
                break;        
            default:
                // store transactions that failed after second try with more gas
                this.botStateManager.addFailedTransaction(event.transactionHash, event.blockNumber);
        }
    }


    async sendPong(event: EventLog, gasLimit: number): Promise<void> {
        const txHash = event.transactionHash;
        const blockNumber = event.blockNumber;
        try {
            const tx = await this.contract.pong(txHash, { gasLimit });
            logger.info(`Pong sent for tx ${txHash}: ${tx.hash}`);
            const receipt = await tx.wait();
            if (receipt.status === 1) {
                logger.info(`Pong confirmed at block ${blockNumber}`);
                this.botStateManager.addSentTransaction(txHash, blockNumber);
            } else {
                throw new Error("Transaction failed");
            }
        } catch (error) {
            console.error(`Error: ${(error as Error).message}. sent tx ${txHash} failed.`);
            throw error;
        }
    }

    async catchMissedEventsFromTo(startBlockNumber: number, endBlockNumber: number): Promise<void> {
        if (endBlockNumber > startBlockNumber) {
            logger.info(`Checking missed events from ${startBlockNumber + 1} to ${endBlockNumber}`);
            const events = await this.contract.queryFilter('Ping', startBlockNumber + 1, endBlockNumber) as EventLog[];
            logger.info(`Found ${events.length} events`);
            for (const event of events) {
                logger.info(`Found missed Ping event: tx ${event.transactionHash} on block ${event.blockNumber}`);
                
                // if there are no pong on event ping
                if (!this.botStateManager.getSentTransactions()[event.transactionHash])
                    this.eventQueue.push(event);
                else
                    logger.info(`Missed Ping event: tx ${event.transactionHash} on block ${event.blockNumber} was already sent`);
            }
        }

        this.botStateManager.setLastBlock(endBlockNumber);
        this.botStateManager.clearTransactionsBeforeBlock(endBlockNumber);
    }

}

// ------------------------- START ---------------------

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
    ),
    transports: [
        new winston.transports.File({ filename: 'bot.log' }), 
        new winston.transports.Console()
    ]
});

const configuration = new Configuration(process.env.INFURA_API_KEY!); 
const stateManger = new BotStateManagerFS(configuration);

const bot = new Bot(
    configuration,
    new Queue(COMMON_PING_EVENT_QUEUE, 1),
    new Queue(FORCE_PING_EVENT_QUEUE, 2),
    stateManger
);

bot.init().catch(error => logger.error(`Bot initialization failed: ${error.message}`));