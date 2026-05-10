import dns from 'dns';
import mongoose from 'mongoose';
import config from './index';

mongoose.set('strictQuery', true);

const connectDatabase = async (): Promise<void> => {
  try {
    if (config.dnsServers.length > 0) {
      dns.setServers(config.dnsServers);
    }

    await mongoose.connect(config.mongoUri, {
      autoIndex: true,
      serverSelectionTimeoutMS: 5000
    });
    console.log('MongoDB connected');
  } catch (error) {
    console.error('MongoDB connection error', (error as Error).message);
    process.exit(1);
  }
};

export default connectDatabase;
