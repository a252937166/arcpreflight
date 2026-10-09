// @vitest-environment jsdom
// Review 2026-10-09, item 1: with real keyed unmount/remount — delay run A's download, switch to run B, export B, release A: B's state
// stays B's. The panel drops results after unmounting; the page's hook rejects callbacks for a run that is not on screen.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { NOW, REQUEST } from "./fixtures";

vi.mock("../src/App", () => ({ useNet: () => ({ net: null, link: (t: string) => t, refresh: () => {}, instances: [], testWallet: false }) }));
const saveJson = vi.fn();
vi.mock("../src/lib/download", () => ({ saveJson: (...a: unknown[]) => saveJson(...a) }));
vi.mock("../src/components/Typewriter", () => ({ Typewriter: () => null, narrate: () => null }));
import { RunPanel } from "../src/components/RunPanel";
import { useRunLocal } from "../src/lib/runLocal";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const runOf = (runId: string): any => ({ runId, fixture: "APPROVED_PAYMENT", state: "DONE", labels: [], steps: [], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), expected: null, headline: null, result: null, outcome: { kind: "FAILED", text: "", source: "state" } });
const A = runOf(REQUEST), B = runOf("22222222-2222-4222-8222-222222222222");
const seen: { runId: string; local: unknown }[] = [];
function Host({ run }: { run: any }) {
  const { local, onLocal } = useRunLocal(run.runId);
  seen.push({ runId: run.runId, local });
  return <MemoryRouter><div id="host" data-local={JSON.stringify(local)}><RunPanel key={run.runId} run={run} net={null} onLocal={onLocal} /></div></MemoryRouter>;
}
let root: Root; let el: HTMLDivElement;
beforeEach(() => { el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el); seen.length = 0; saveJson.mockReset(); (HTMLCanvasElement.prototype as any).getContext = () => null; });
afterEach(() => { act(() => { root.unmount(); }); el.remove(); vi.unstubAllGlobals(); });

it("delay A → switch to B → export B → release A: B's export stays, A's late result is dropped (keyed unmount + parent guard)", async () => {
  const bundle = { passportBundleVersion: "1.0", files: { "manifest.json": "{}" } };
  let releaseA: (() => void) | null = null;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes(A.runId)) await new Promise<void>((r) => { releaseA = r; });
    return new Response(JSON.stringify(bundle), { status: 200, headers: { "content-type": "application/json" } });
  }));
  const btn = () => el.querySelector<HTMLButtonElement>("#btn-passport")!;
  await act(async () => { root.render(<Host run={A} />); });
  await act(async () => { btn().click(); }); // A's download hangs on the gate
  expect(btn().textContent).toContain("exporting");
  await act(async () => { root.render(<Host run={B} />); }); // keyed remount: A's panel is gone
  expect(btn().textContent).toBe("Download Payment Passport");
  await act(async () => { btn().click(); }); // B downloads at once
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(btn().textContent).toContain("again");
  expect(seen.at(-1)!.local).toEqual({ runId: B.runId, exported: true, verified: null });
  await act(async () => { releaseA!(); await new Promise((r) => setTimeout(r, 0)); }); // A's result arrives late
  expect(seen.at(-1)!.local).toEqual({ runId: B.runId, exported: true, verified: null }); // unchanged
  expect(el.querySelector("#host")!.getAttribute("data-local")).toContain(B.runId);
  expect(btn().textContent).toContain("again");
  expect(saveJson).toHaveBeenCalledTimes(1); expect(String(saveJson.mock.calls[0][0])).toContain(B.runId.slice(0, 8)); // only B was saved
  expect(releaseA).not.toBeNull();
});
