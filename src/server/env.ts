import { z } from "zod";

const envSchema = z
  .object({
    APP_PORT: z.coerce.number().int().positive().default(7777),
    APP_PASSWORD: z.string().min(1, "required, must not be empty"),
    SESSION_SECRET: z.string().min(1, "required, must not be empty"),
    SESSION_TTL_HOURS: z.coerce.number().positive().default(168),
    TLS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    TLS_CERT_PATH: z.string().optional(),
    TLS_KEY_PATH: z.string().optional(),
    TOPICS_DIR: z.string().default("/data/topics"),
    POSTGRES_HOST: z.string().default("postgres"),
    POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
    POSTGRES_DB: z.string().default("daybook"),
    POSTGRES_USER: z.string().default("postgres"),
    POSTGRES_PASSWORD: z.string().min(1, "required, must not be empty"),
    TZ: z.string().default("Europe/Madrid"),
  })
  .refine((e) => !e.TLS_ENABLED || (e.TLS_CERT_PATH && e.TLS_KEY_PATH), {
    message: "TLS_CERT_PATH and TLS_KEY_PATH are required when TLS_ENABLED=true",
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".") || "(env)"}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
