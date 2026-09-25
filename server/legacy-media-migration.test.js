import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { loadServerConfig } from "./config.js";
import { migrate, migrationsDirectory } from "./migrate.js";
import { ProtectedMediaGateway } from "./media-gateway.js";
import { PrivateMediaStorage } from "./media-storage.js";
import { createIndexedOwnershipVerifier } from "./ownership.js";
import { createPersistenceRepository } from "./repositories.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
const holder = "0x1111111111111111111111111111111111111111";
const outsider = "0x2222222222222222222222222222222222222222";
const contract = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const storageKey = "legacy/hollow.mp3";
const assetKey = "legacy-hollow-asset";
const audio = "legacy-protected-bytes";

describe.skipIf(!testDatabaseUrl)("legacy protected media after migration 015", () => {
  it("streams a pre-migration storageKey experience for the token holder and returns 403 for everyone else", async () => {
    const admin = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 2 });
    const name = `void_legacy_media_${randomBytes(6).toString("hex")}`;
    const partial = await mkdtemp(join(tmpdir(), "void-migrations-"));
    const root = await mkdtemp(join(tmpdir(), "void-legacy-media-"));
    let pool;
    try {
      await admin.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$");
      await admin.query(`CREATE DATABASE "${name}"`);
      const url = new URL(testDatabaseUrl);
      url.pathname = `/${name}`;
      const config = loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" });
      pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 4 });
      await cp(migrationsDirectory, partial, { recursive: true });
      await rm(join(partial, "015_artist_owned_media_assets.sql"));
      await migrate({ pool, config, directory: partial });

      await pool.query("INSERT INTO artists (id, slug, display_name) VALUES ('artist-legacy', 'legacy-artist', 'Legacy Artist')");
      await pool.query(
        `INSERT INTO experiences (id, artist_id, title, experience_type, status, requirements, media_config)
         VALUES ('exp-legacy', 'artist-legacy', 'Hollow', 'AUDIO', 'PUBLISHED', $1::jsonb, $2::jsonb)`,
        [
          JSON.stringify([{ type: "erc1155-balance", contract, tokenIds: ["7"], minAmount: "1", chainId: 43113 }]),
          JSON.stringify({ protected: true, protectedMedia: [{ mediaType: "AUDIO", storageKey, contentType: "audio/mpeg" }] }),
        ],
      );
      await pool.query(
        "INSERT INTO media_assets (media_key, experience_id, media_type, chain_id, storage_key) VALUES ($1, 'exp-legacy', 'AUDIO', 43113, $2)",
        [assetKey, storageKey],
      );
      await pool.query(
        `INSERT INTO indexer_checkpoints (chain_id, contract_address, contract_type, next_block, last_processed_block, status, latest_known_block, last_successful_run_at)
         VALUES (43113, $1, 'ERC1155', 10, 10, 'IDLE', 10, now())`,
        [contract],
      );
      await pool.query(
        `INSERT INTO ownership_snapshots (chain_id, contract_address, token_id, wallet_address, amount, source_block_number, source_block_hash, synchronization_watermark)
         VALUES (43113, $1, 7, $2, 1, 10, '0xabc', 'FINALIZED')`,
        [contract, holder],
      );

      const before = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'media_assets' AND column_name = 'artist_id'");
      expect(before.rows).toHaveLength(0);
      await migrate({ pool, config });

      const asset = await pool.query("SELECT id, artist_id, storage_key FROM media_assets WHERE media_key = $1", [assetKey]);
      expect(asset.rows[0]).toMatchObject({ id: assetKey, artist_id: "artist-legacy", storage_key: storageKey });
      const experience = await pool.query("SELECT media_config FROM experiences WHERE id = 'exp-legacy'");
      expect(experience.rows[0].media_config.protectedMedia[0].assetId).toBe(assetKey);

      await mkdir(join(root, "legacy"), { recursive: true });
      await writeFile(join(root, storageKey), audio);
      const mediaConfig = { driver: "filesystem", privateRoot: root, grantTtlSeconds: 300, signedUrlTtlSeconds: 60, maxBytes: 1024 * 1024, auditHashSecret: "test-audit-secret" };
      const ownershipConfig = { authAllowedChainIds: [43113], ownershipMaxIndexerLagBlocks: 24, ownershipMaxIndexerStalenessMs: 120_000 };
      const gatewayFor = (wallet) => new ProtectedMediaGateway({
        db: pool,
        repository: createPersistenceRepository(pool),
        authenticator: async () => ({ wallet }),
        ownershipVerifier: createIndexedOwnershipVerifier({ db: pool, config: ownershipConfig }),
        storage: new PrivateMediaStorage({ config: mediaConfig }),
        mediaConfig,
      });
      const request = { headers: {}, requestId: "legacy-1", ip: "127.0.0.1" };

      await expect(gatewayFor(outsider).issueGrant({ request, input: { wallet: outsider, experienceId: "exp-legacy", mediaType: "AUDIO" } })).rejects.toMatchObject({ status: 403, code: "EXPERIENCE_ENTITLEMENT_REQUIRED" });

      const granted = await gatewayFor(holder).issueGrant({ request, input: { wallet: holder, experienceId: "exp-legacy", mediaType: "AUDIO" } });
      const media = await gatewayFor(holder).openMedia({ request, grantId: granted.grantId });
      expect(media).toMatchObject({ type: "stream", contentType: "audio/mpeg" });
      const chunks = [];
      for await (const chunk of media.stream) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe(audio);
    } finally {
      await pool?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
      await admin.end();
      await rm(partial, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);
});
