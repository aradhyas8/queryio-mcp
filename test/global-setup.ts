import { execSync } from "node:child_process";
import pg from "pg";
import { ADMIN_URL, TEST_DB } from "./db.js";

export default async function setup() {
  if (!process.env.QUERYIO_TEST_ADMIN_URL) {
    execSync("docker compose up -d --wait postgres", { stdio: "inherit" });
  }
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }
}
