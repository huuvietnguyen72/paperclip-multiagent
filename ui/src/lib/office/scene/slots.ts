/**
 * Remembers which slot (desk or standing spot) each member holds within a group, so members keep their
 * place when others come and go. Newcomers take the lowest free slot.
 */
export class SlotBook {
  private readonly holders = new Map<string, { group: string; slot: number }>();

  /** `wanted` maps member id → group for everyone who should hold a slot now. Returns member id → slot. */
  sync(wanted: ReadonlyMap<string, string>): Map<string, number> {
    for (const [id, held] of this.holders) {
      if (wanted.get(id) !== held.group) this.holders.delete(id);
    }

    const taken = new Map<string, Set<number>>();
    for (const held of this.holders.values()) {
      const set = taken.get(held.group) ?? new Set<number>();
      set.add(held.slot);
      taken.set(held.group, set);
    }

    for (const [id, group] of wanted) {
      if (this.holders.has(id)) continue;
      const set = taken.get(group) ?? new Set<number>();
      let slot = 0;
      while (set.has(slot)) slot += 1;
      set.add(slot);
      taken.set(group, set);
      this.holders.set(id, { group, slot });
    }

    return new Map(Array.from(this.holders, ([id, held]) => [id, held.slot]));
  }
}
