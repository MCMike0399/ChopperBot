import type { Capability } from './capability.js';

export class CapabilityRegistry {
  private readonly byId = new Map<string, Capability>();

  register(cap: Capability): void {
    if (this.byId.has(cap.id)) {
      throw new Error(`Capability id collision: "${cap.id}" registered twice`);
    }
    this.byId.set(cap.id, cap);
  }

  get(id: string): Capability | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  list(): Capability[] {
    return [...this.byId.values()];
  }
}
