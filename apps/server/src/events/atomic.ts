import type { DomainEventInput } from "@plotroom/core";
import type { PlotroomDatabase } from "@plotroom/db";
import type { EventBus, EventSink } from "./bus.js";

/**
 * One gesture, one transaction, and nothing announced until it committed
 * (principle 9, principle 10, §2.1's stream).
 *
 * A cascade writes to more than one store — a destruction soft-deletes its
 * subject *and* takes the node and its wires off the board; the undo puts both
 * back — and until this existed each of those was its own statement. A crash or
 * a throw between two of them left the board and the records disagreeing: a
 * card with no record behind it, or a record with no card. Both writes belong in
 * one transaction, so either the whole gesture happened or none of it did.
 *
 * **Announcements are buffered rather than published as they are decided.** The
 * bus is not transactional and cannot be: a subscriber told "node deleted" has
 * already re-rendered by the time a later statement in the same gesture throws,
 * and no rollback reaches it. So `work` announces into the sink it is handed,
 * and those events reach the bus only after the transaction returned — a
 * rollback throws past the publish loop, and nothing was ever said. The order
 * they were announced in is the order they are published in, which is what the
 * announce helpers' leaves-first / roots-first ordering depends on.
 *
 * Store methods that open transactions of their own compose here: SQLite nests
 * them as savepoints, so an inner one still rolls its own writes back and the
 * outer one still rolls back the lot.
 */
export function atomically<T>(
  db: PlotroomDatabase,
  bus: EventBus,
  work: (announce: EventSink) => T,
): T {
  const buffered: DomainEventInput[] = [];
  const result = db.db.transaction(() =>
    work({
      publish: (input) => {
        buffered.push(input);
      },
    }),
  );

  for (const input of buffered) bus.publish(input);

  return result;
}
