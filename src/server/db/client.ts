import postgres from "postgres";

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

export type Sql = ReturnType<typeof postgres>;

export function createDbClient(config: DbConfig): Sql {
  return postgres({ ...config, onnotice: () => {} });
}

const SCHEMA_PATH = new URL("./schema.sql", import.meta.url).pathname;

export async function applySchema(sql: Sql, retries = 5, delayMs = 2000): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await sql.file(SCHEMA_PATH);
      return;
    } catch (err) {
      if (attempt >= retries) throw err;
      console.error(`schema apply failed (attempt ${attempt}/${retries}), retrying in ${delayMs}ms`);
      await Bun.sleep(delayMs);
    }
  }
}
