import { describe, expect, it } from "vitest";
import { connectionStringForPool } from "./db.js";

describe("managed Postgres SSL connection strings", () => {
  it("removes sslmode=require so pg does not override rejectUnauthorized=false", () => {
    const result = connectionStringForPool("postgres://user:pass@db.example/postgres?sslmode=require&connect_timeout=5", false);
    expect(result).toBe("postgres://user:pass@db.example/postgres?connect_timeout=5");
  });

  it("preserves ssl parameters when certificate verification remains enabled", () => {
    const input = "postgres://user:pass@db.example/postgres?sslmode=verify-full";
    expect(connectionStringForPool(input, true)).toBe(input);
  });
});
