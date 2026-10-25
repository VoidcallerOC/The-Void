// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { CatalogProvider, useMarketplaceCatalogs } from "./catalog-source.js";

const CATALOG_PATHS = ["/api/artists", "/api/releases", "/api/editions", "/api/experiences"];

function Consumer({ label }) {
  const catalog = useMarketplaceCatalogs();
  return <p data-testid={label}>{catalog.publishedLoading ? "loading" : `ready:${catalog.releases.length}`}</p>;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("CatalogProvider", () => {
  it("loads the published catalog once for every consumer under the provider", async () => {
    const fetchImpl = vi.fn(async (url) => ({ ok: true, json: async () => ({ data: String(url).includes("/api/releases") ? [{ id: "r1", artist_id: "voidcaller", title: "One", status: "PUBLISHED" }] : [] }) }));
    vi.stubGlobal("fetch", fetchImpl);
    const { getByTestId } = render(<CatalogProvider><Consumer label="layout" /><Consumer label="page" /><Consumer label="panel" /></CatalogProvider>);
    await waitFor(() => expect(getByTestId("page").textContent).toMatch(/^ready:/));
    const paths = fetchImpl.mock.calls.map(([url]) => String(url).replace(/^[^/]*\/\/[^/]+/, ""));
    expect(paths.sort()).toEqual([...CATALOG_PATHS].sort());
    expect(getByTestId("layout").textContent).toBe(getByTestId("page").textContent);
    expect(getByTestId("panel").textContent).toBe(getByTestId("page").textContent);
  });

  it("still loads its own copy when rendered without a provider", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) }));
    vi.stubGlobal("fetch", fetchImpl);
    const { getByTestId } = render(<Consumer label="alone" />);
    await waitFor(() => expect(getByTestId("alone").textContent).toMatch(/^ready:/));
    expect(fetchImpl).toHaveBeenCalledTimes(CATALOG_PATHS.length);
  });

  it("reports an unreachable API as loaded-but-empty instead of hanging", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const { getByTestId } = render(<CatalogProvider><Consumer label="page" /></CatalogProvider>);
    await waitFor(() => expect(getByTestId("page").textContent).toMatch(/^ready:/));
  });
});
