import { describe, expect, it } from "vitest";

import {
  answerQuestion,
  createFixtureQuestionDataSource,
  type OpenQuestion,
} from "./question-source.js";

function question(overrides: Partial<OpenQuestion> = {}): OpenQuestion {
  return {
    id: "q1",
    nodeId: "session-1",
    text: "keep going with the migration?",
    options: ["yes", "no", "ask again later"],
    raisedAt: 10,
    answeredValue: null,
    ...overrides,
  };
}

describe("answerQuestion", () => {
  it("records the picked option, leaving the others as paths not taken", () => {
    const next = answerQuestion([question()], "q1", "yes");
    expect(next[0]?.answeredValue).toBe("yes");
    expect(next[0]?.options).toEqual(["yes", "no", "ask again later"]);
  });

  it("keeps the first answer — a second pick on an already-answered question is a no-op", () => {
    const answered = answerQuestion([question()], "q1", "yes");
    const reAnswered = answerQuestion(answered, "q1", "no");
    expect(reAnswered[0]?.answeredValue).toBe("yes");
  });

  it("ignores a value that is not one of the question's options", () => {
    const next = answerQuestion([question()], "q1", "not an option");
    expect(next[0]?.answeredValue).toBeNull();
  });

  it("leaves every other question untouched", () => {
    const other = question({ id: "q2" });
    const next = answerQuestion([question(), other], "q1", "yes");
    expect(next.find((q) => q.id === "q2")).toEqual(other);
  });
});

describe("createFixtureQuestionDataSource", () => {
  it("lists the open questions it was seeded with", async () => {
    const source = createFixtureQuestionDataSource([question()]);
    expect(await source.listOpen()).toEqual([question()]);
  });

  it("notifies subscribers immediately, and again once answered", async () => {
    const source = createFixtureQuestionDataSource([question()]);
    const seen: (readonly OpenQuestion[])[] = [];
    const unsubscribe = source.subscribe((open) => seen.push(open));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]?.answeredValue).toBeNull();

    await source.answer("q1", "yes");

    expect(seen).toHaveLength(2);
    expect(seen[1]?.[0]?.answeredValue).toBe("yes");

    unsubscribe();
    await source.answer("q1", "no"); // already answered — no third notification expected
    expect(seen).toHaveLength(2);
  });

  it("answering never removes the question from the open list", async () => {
    const source = createFixtureQuestionDataSource([question()]);
    await source.answer("q1", "yes");
    const open = await source.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0]?.answeredValue).toBe("yes");
  });
});
