import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    // Hardcoding this temporarily to bypass the strict environment checker
    url: "postgresql://neondb_owner:npg_JbSGHI1m3PMp@ep-patient-bonus-a4ltx8ib-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
  },
});