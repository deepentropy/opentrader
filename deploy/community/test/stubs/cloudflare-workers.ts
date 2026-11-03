// Unit tests run in Node: a stand-in for the Workers runtime module.
export class DurableObject<E = unknown> {
  constructor(public ctx: unknown, public env: E) {}
}
