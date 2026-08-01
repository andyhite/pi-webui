/**
 * "That id names nothing", as a type rather than a message.
 *
 * The stores refuse an unknown id by throwing; the API layer has to turn that
 * into a 404 rather than a 500 (Epic 2.2: a refusal is never an internal
 * error). Matching on an error *class* keeps that mapping honest — string
 * matching on messages would silently start returning 500s the day a message
 * is reworded.
 */
export class EntityNotFound extends Error {
  constructor(
    readonly entity: string,
    readonly id: string,
    message = `unknown ${entity} ${id}`,
  ) {
    super(message);
    this.name = "EntityNotFound";
  }
}
