import { describe, expect, test } from "vitest";

import { personalSignalIndex, personalSignals } from "../src/services/personalSignals.js";

describe("query-blind personal signal indexing", () => {
  test("surfaces incidental personal quantities and dates without indexing assistant prose", () => {
    const signals = personalSignals([{
      session_id: "s1",
      date: "2025/01/01",
      turns: [
        {
          role: "user",
          content: "Can you explain product photography? By the way, I now have 350 subscribers after two weeks. I spent 10-12 hours on my current art project.",
        },
        {
          role: "assistant",
          content: "I recommend posting three times each week.",
        },
      ],
    }]);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({ sessionId: "s1", sessionSlot: "session_1", turnIndex: 0, turnSlot: "turn_1", sentenceIndex: 1, priority: "high" });
    expect(signals[0]?.signalId).toMatch(/^signal_[a-f0-9]{16}$/);
    expect(signals[0]?.reasons).toEqual(expect.arrayContaining(["first_person", "quantity", "time", "change"]));
    expect(signals[1]?.text).toContain("10-12 hours");
  });

  test("assigns stable IDs independent of priority-ranked neighbors", () => {
    const target = {
      session_id: "target",
      date: "2025/01/02",
      turns: [{ role: "user" as const, content: "I attended the workshop one week before Friday." }],
    };
    const alone = personalSignals([target])[0];
    const withNeighbor = personalSignals([{
      session_id: "neighbor",
      date: "2025/01/01",
      turns: [{ role: "user" as const, content: "I spent 12 hours on my project last Monday." }],
    }, target]).find((signal) => signal.sessionId === "target");

    expect(withNeighbor?.signalId).toBe(alone?.signalId);
  });

  test("leaves generic second-person questions out of the candidate index", () => {
    expect(personalSignals([{
      session_id: "s1",
      date: "2025/01/01",
      turns: [{ role: "user", content: "Can you explain how solar panels work?" }],
    }])).toEqual([]);
  });

  test("raises completed dated autobiographical events into the required signal ledger", () => {
    const signals = personalSignals([{
      session_id: "event",
      date: "2022/03/21",
      turns: [{
        role: "user",
        content: "I've been inspired since that baking workshop I took at a local school yesterday.",
      }],
    }]);
    expect(signals[0]).toMatchObject({
      sessionId: "event",
      priority: "high",
    });
    expect(signals[0]?.reasons).toEqual(
      expect.arrayContaining(["first_person", "time", "completed_event"]),
    );
  });

  test("does not mistake modal may for a month but detects May and numeric timestamps", () => {
    const signals = personalSignals([{
      session_id: "dates",
      date: "2025/01/01",
      turns: [{ role: "user", content: "I may attend. I attended on May 3. I left at 16:30 on 2025-05-04." }],
    }]);
    expect(signals.find((signal) => signal.text === "I may attend.")?.reasons).not.toContain("time");
    expect(signals.find((signal) => signal.text === "I attended on May 3.")?.reasons).toContain("time");
    expect(signals.find((signal) => signal.text.includes("16:30"))?.reasons).toContain("time");
  });

  test("adds topic-agnostic deterministic operand hints to the prompt ledger", () => {
    const index = personalSignalIndex([{
      session_id: "operands",
      date: "2023/05/20 (Sat) 23:43",
      turns: [{
        role: "user",
        content: "I left at 7 AM last Monday after two hours, and I now attend three times a week with a 10-20% buffer.",
      }],
    }]);
    const hints = index.requiredHighPrioritySignals[0]?.operandHints;
    expect(hints?.resolvedDates).toEqual([{ surface: "last Monday", isoDate: "2023-05-15" }]);
    expect(hints?.clockTimes).toEqual([{ surface: "7 AM", normalized: "07:00" }]);
    expect(hints?.durations).toEqual([{ surface: "two hours", value: 2, unit: "hour" }]);
    expect(hints?.frequencies).toEqual([{
      surface: "three times a week",
      value: 3,
      unit: "times_per_week",
    }]);
    expect(hints?.numericRanges).toEqual([{
      surface: "10-20%",
      minimum: 10,
      maximum: 20,
      unit: "%",
    }]);
  });

  test("does not treat possession phrasing with got as a completed event", () => {
    const signal = personalSignals([{
      session_id: "possession",
      date: "2025/01/01",
      turns: [{ role: "user", content: "I've got a report due next Friday." }],
    }])[0];
    expect(signal?.reasons).not.toContain("completed_event");
  });
});
