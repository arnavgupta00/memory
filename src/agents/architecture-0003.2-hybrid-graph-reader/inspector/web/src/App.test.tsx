import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import App from "./App";

vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));

test("renders the observatory shell and accessible landmarks", async () => {
  render(<App />);
  expect(screen.getByText("OBSERVATORY")).toBeTruthy();
  expect(screen.getByLabelText("Run and case library")).toBeTruthy();
  expect(screen.getByLabelText("Selected memory inspector")).toBeTruthy();
});
