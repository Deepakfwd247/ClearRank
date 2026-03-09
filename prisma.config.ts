import { defineConfig } from '@prisma/config';
import dotenv from 'dotenv';

// Load the .env file so Prisma can find it
dotenv.config();

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL,
  },
});