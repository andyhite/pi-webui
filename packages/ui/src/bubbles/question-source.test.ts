import { describe, expect, it, vi } from "vitest";
import type { SessionId, SessionQuestion } from "@plotroom/core";

import type { HttpClient } from "../transport/http.js";
import type { MinimalWebSocket, WebSocketFactory } from "../transport/ws.js";
import {
  answerQuestion,
  createApiQuestionDataSource,
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

/* ------------------------------------------------------------- live (Stage 2) */

function sessionQuestion(
  overrides: Partial<SessionQuestion> = {},
): SessionQuestion {
  return {
    id: "q1",
    sessionId: "session-1" as SessionId,
    requestId: null,
    text: "keep going with the migration?",
    options: [
      { id: "opt-yes", label: "yes", detail: null },
      { id: "opt-no", label: "no", detail: null },
    ],
    freeForm: "none",
    attention: null,
    askedAt: 10,
    answer: null,
    ...overrides,
  };
}

function fakeSocket(): MinimalWebSocket {
  return {
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    send: vi.fn(),
    close: vi.fn(),
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createApiQuestionDataSource", () => {
  it("bootstraps by asking every session for its questions, then reports them as open questions", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/sessions") {
        return { sessions: [{ session: { id: "session-1" } }] };
      }
      expect(path).toBe("/api/sessions/session-1/questions");
      return {
        questions: [{ question: sessionQuestion(), pathsNotTaken: [] }],
      };
    });
    const http = { get } as unknown as HttpClient;
    const source = createApiQuestionDataSource({
      http,
      createSocket: vi.fn() as unknown as WebSocketFactory,
    });

    const open = await source.listOpen();
    expect(open).toEqual([
      {
        id: "q1",
        nodeId: "session-1",
        text: "keep going with the migration?",
        options: ["yes", "no"],
        raisedAt: 10,
        answeredValue: null,
      },
    ]);
  });

  it("a session_question event updates a subscriber live", async () => {
    const socket = fakeSocket();
    const createSocket: WebSocketFactory = vi.fn(() => socket);
    const get = vi.fn(async (path: string) => {
      if (path === "/api/sessions") return { sessions: [] };
      return { questions: [] };
    });
    const http = { get } as unknown as HttpClient;

    const source = createApiQuestionDataSource({ http, createSocket });
    const onChange = vi.fn();
    source.subscribe(onChange);
    await flush();

    socket.onmessage?.({
      data: JSON.stringify({
        type: "event",
        event: {
          id: "evt_1",
          seq: 1,
          occurredAt: 0,
          author: { kind: "human" },
          entity: "session_question",
          verb: "created",
          question: sessionQuestion(),
          pathsNotTaken: [],
        },
      }),
    });

    expect(onChange.mock.calls.at(-1)?.[0]).toEqual([
      {
        id: "q1",
        nodeId: "session-1",
        text: "keep going with the migration?",
        options: ["yes", "no"],
        raisedAt: 10,
        answeredValue: null,
      },
    ]);
  });

  it("answer resolves the picked label to its optionId before posting", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/sessions") {
        return { sessions: [{ session: { id: "session-1" } }] };
      }
      return {
        questions: [{ question: sessionQuestion(), pathsNotTaken: [] }],
      };
    });
    const post = vi.fn(async () => ({
      question: sessionQuestion({
        answer: {
          optionId: "opt-yes",
          text: null,
          by: { kind: "human" },
          at: 5,
        },
      }),
    }));
    const http = { get, post } as unknown as HttpClient;
    const source = createApiQuestionDataSource({
      http,
      createSocket: vi.fn() as unknown as WebSocketFactory,
    });

    await source.listOpen(); // bootstraps so the question's options are known
    await source.answer("q1", "yes");

    expect(post).toHaveBeenCalledWith("/api/questions/q1/answer", {
      optionId: "opt-yes",
    });
    const open = await source.listOpen();
    expect(open[0]?.answeredValue).toBe("yes");
  });

  it("answer is a no-op for a value that names no real option", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/sessions") {
        return { sessions: [{ session: { id: "session-1" } }] };
      }
      return {
        questions: [{ question: sessionQuestion(), pathsNotTaken: [] }],
      };
    });
    const post = vi.fn();
    const http = { get, post } as unknown as HttpClient;
    const source = createApiQuestionDataSource({
      http,
      createSocket: vi.fn() as unknown as WebSocketFactory,
    });

    await source.listOpen();
    await source.answer("q1", "not a real option");

    expect(post).not.toHaveBeenCalled();
  });

  it("re-bootstraps on reconnect instead of swallowing the resync (bootstrapped-guard regression)", async () => {
    vi.useFakeTimers();
    try {
      const sockets = [fakeSocket(), fakeSocket()];
      let created = 0;
      const createSocket: WebSocketFactory = vi.fn(() => {
        const next = sockets[created];
        created += 1;
        if (!next) throw new Error("unexpected extra socket");
        return next;
      });

      let questionIds = ["q1"];
      const get = vi.fn(async (path: string) => {
        if (path === "/api/sessions") {
          return { sessions: [{ session: { id: "session-1" } }] };
        }
        return {
          questions: questionIds.map((id) => ({
            question: sessionQuestion({ id }),
            pathsNotTaken: [],
          })),
        };
      });
      const http = { get } as unknown as HttpClient;

      const source = createApiQuestionDataSource({ http, createSocket });
      const onChange = vi.fn();
      source.subscribe(onChange);
      await vi.advanceTimersByTimeAsync(0);

      expect(onChange.mock.calls.at(-1)?.[0]).toHaveLength(1);

      // The server raised a second question while the socket was down, and
      // the drop means the `session_question` event for it was missed —
      // only a fresh bootstrap on reconnect can recover it.
      questionIds = ["q1", "q2"];
      sockets[0]?.onclose?.();
      await vi.advanceTimersByTimeAsync(1_000);
      sockets[1]?.onopen?.();
      await vi.advanceTimersByTimeAsync(0);

      expect(get).toHaveBeenCalledWith("/api/sessions");
      const sessionsCalls = get.mock.calls.filter(
        ([path]) => path === "/api/sessions",
      );
      expect(sessionsCalls.length).toBeGreaterThanOrEqual(2);
      expect(onChange.mock.calls.at(-1)?.[0]).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
