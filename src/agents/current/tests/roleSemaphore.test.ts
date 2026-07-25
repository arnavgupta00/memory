import { describe, expect, test } from "vitest";

import { RoleSemaphore } from "../src/services/roleSemaphore.js";

describe("run-global role semaphore", () => {
  test("caps concurrent work without losing queued operations", async () => {
    const semaphore = new RoleSemaphore(2);
    let active = 0;
    let maximum = 0;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => semaphore.use(async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return index;
      })),
    );
    expect(maximum).toBe(2);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
