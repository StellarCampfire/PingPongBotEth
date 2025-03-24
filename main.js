import 'dotenv/config';
import { JsonRpcProvider, Wallet, Contract } from 'ethers';

const providerUrl = `https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`;
const contractAddress = '0xa7f42ff7433cb268dd7d59be62b00c30ded28d3d';
const contractABI = [
  'event Ping()',
  'function pong(bytes32 _txHash) external'
];

const provider = new JsonRpcProvider(providerUrl);
const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
const contract = new Contract(contractAddress, contractABI, wallet);

// TODO startblock loading
const startBlock = 7968746;


async function catchMissedEventsFromTo(startBlockNumber, endBlockNumber){
    if (endBlockNumber > startBlockNumber){
        const events = await contract.queryFilter('Ping', startBlockNumber + 1, endBlockNumber);
        for (const event of events) {
            // TODO send pong
            console.log(`Finded missed ping event on block ${event.blockNumber}`)
        }
    }
}

async function startBotFromBlock(blockNumber) {
    const startBotBlock = await provider.getBlockNumber();
    console.log(`Bot started, listening for Pings from block ${startBotBlock}`);
    // Listen for Ping events
    contract.on('Ping', async (event) => {
      if (event.blockNumber > startBotBlock) {
        // TODO send pong
        console.log(`Catching new Ping event on block: ${event.blockNumber}`)
      }
    });
    
    // Trying to find missed events
    await catchMissedEventsFromTo(blockNumber, startBotBlock);
}
  
startBotFromBlock(startBlock);