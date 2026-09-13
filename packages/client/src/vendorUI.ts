import {
  buyPrice,
  DEFAULT_CLASS,
  describeItem,
  GOOD_IDS,
  GOODS,
  goodsValue,
  INVENTORY_SIZE,
  isGoodId,
  packValue,
  RARITY,
  rarityHex,
  sellPrice,
  STAT_ORDER,
  STATS,
  TALK_RANGE,
  vendorStock,
  type ClassId,
  type GoodId,
  type Goods,
  type ItemKey,
  type VillagerDefinition,
} from "@mmo/shared";

/**
 * Trading with a vendor (E beside Mott in Daso or Corran in Fanshona): their
 * stock on top, your satchel and pack underneath, and a button that sells the
 * lot.
 *
 * It decides nothing. Buying and selling are requests; the server checks gold,
 * room and distance, and answers with a new profile, which is the only thing
 * this draws from. The stock comes from `vendorStock`, the same function the
 * server sells from.
 */

export interface VendorHooks {
  buy(vendor: string, index: number): void;
  sell(vendor: string, item: ItemKey): void;
  sellAll(vendor: string): void;
  /** All of one good, or with none named, the whole satchel. */
  sellGoods(vendor: string, good?: GoodId): void;
  /** What wearing a piece of stock would change against what is worn now. */
  compare(item: ItemKey): string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char] as string));
}

export class VendorUI {
  private readonly panel: HTMLElement;
  private vendor: VillagerDefinition | undefined;
  private inventory: ItemKey[] = [];
  private goods: Goods = {};
  private gold = 0;
  private level = 1;
  private classId: ClassId = DEFAULT_CLASS;
  /** Sell all asks once — it empties the whole pack. */
  private confirming = false;

  constructor(private readonly hooks: VendorHooks) {
    this.panel = document.createElement("div");
    this.panel.id = "vendor";
    this.panel.hidden = true;
    document.body.appendChild(this.panel);
    // A click in the panel must not also cast the spell on that key.
    this.panel.addEventListener("keydown", (event) => event.stopPropagation());
    this.panel.addEventListener("click", (event) => this.onClick(event));
  }

  get isOpen(): boolean {
    return !this.panel.hidden;
  }

  open(vendor: VillagerDefinition): void {
    this.vendor = vendor;
    this.confirming = false;
    this.panel.hidden = false;
    this.render();
  }

  /** Esc. Returns whether it was open. */
  close(): boolean {
    const was = this.isOpen;
    this.panel.hidden = true;
    this.vendor = undefined;
    return was;
  }

  /** The pack, satchel, gold and level, whenever the server says they changed. */
  setProfile(inventory: ItemKey[], goods: Goods, gold: number, level: number, classId: ClassId): void {
    this.classId = classId;
    this.inventory = inventory;
    this.goods = goods;
    this.gold = gold;
    this.level = level;
    this.confirming = false;
    if (this.isOpen) this.render();
  }

  /** The stock follows your level. */
  setLevel(level: number): void {
    if (level === this.level) return;
    this.level = level;
    if (this.isOpen) this.render();
  }

  /** Once per frame: walk away and the trade ends. */
  update(x: number, z: number): void {
    const vendor = this.vendor;
    if (vendor && this.isOpen && Math.hypot(vendor.x - x, vendor.z - z) > TALK_RANGE + 1.5) this.close();
  }

  private render(): void {
    const vendor = this.vendor;
    if (!vendor?.id) return;
    const full = this.inventory.length >= INVENTORY_SIZE;

    const stock = vendorStock(vendor.id, this.level, this.classId).map((key, index) => {
      const item = describeItem(key);
      if (!item) return "";
      const price = buyPrice(item);
      const stats = STAT_ORDER.filter((stat) => item.stats[stat])
        .map((stat) => `+${item.stats[stat]} ${STATS[stat].name}`).join(" · ");
      const cannot = price > this.gold || full;
      return `<button type="button" class="vendor-item" data-act="buy" data-index="${index}"` +
        ` style="--rarity:${rarityHex(item.rarity)}"${cannot ? " disabled" : ""}>` +
        `<b>${escapeHtml(item.name)}</b><small class="stats">${stats}</small>` +
        `<span class="price">${price} gold</span>${this.hooks.compare(key)}</button>`;
    }).join("");

    const pack = this.inventory.map((key) => {
      const item = describeItem(key);
      if (!item) return "";
      return `<div class="vendor-row" style="--rarity:${rarityHex(item.rarity)}">` +
        `<span><b>${escapeHtml(item.name)}</b><small>${RARITY[item.rarity].name} · level ${item.requiredLevel}</small></span>` +
        `<button type="button" data-act="sell" data-item="${escapeHtml(key)}">Sell · ${sellPrice(item)}</button></div>`;
    }).join("");

    // Goods have no rarity, and no reason to ask before selling: a perch is a
    // perch, and there will be more of them.
    const carried = GOOD_IDS.filter((id) => (this.goods[id] ?? 0) > 0);
    const satchel = carried.map((id) => {
      const good = GOODS[id];
      const count = this.goods[id] ?? 0;
      return `<div class="vendor-row good">` +
        `<span><b>${escapeHtml(good.name)} <em>×${count}</em></b><small>${good.price} gold each</small></span>` +
        `<button type="button" data-act="sellGood" data-good="${id}">Sell · ${good.price * count}</button></div>`;
    }).join("");

    const value = packValue(this.inventory);
    this.panel.innerHTML =
      `<header><b>${escapeHtml(vendor.name)}</b><span class="gold">${this.gold} gold</span>` +
      `<button type="button" data-act="close" title="Close (Esc)">×</button></header>` +
      `<h4>For sale</h4><div class="vendor-stock">${stock}</div>` +
      (carried.length > 0
        ? `<h4>Your satchel <button type="button" class="sell-goods" data-act="sellGoods">Sell all · ${goodsValue(this.goods)} gold</button></h4>` +
          `<div class="vendor-pack">${satchel}</div>`
        : "") +
      `<h4>Your pack <small>${this.inventory.length} / ${INVENTORY_SIZE}</small></h4>` +
      (pack ? `<div class="vendor-pack">${pack}</div>` : `<p class="quest-none">Nothing to sell.</p>`) +
      (this.inventory.length > 0
        ? `<footer><button type="button" class="primary${this.confirming ? " confirm" : ""}" data-act="sellAll">` +
          `${this.confirming ? `Sell all ${this.inventory.length} — sure?` : `Sell all · ${value} gold`}</button></footer>`
        : "");
  }

  private onClick(event: Event): void {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-act]");
    const id = this.vendor?.id;
    if (!target || !id) return;
    switch (target.dataset["act"]) {
      case "close":
        this.close();
        return;
      case "buy":
        this.hooks.buy(id, Number(target.dataset["index"]) || 0);
        return;
      case "sell": {
        const item = target.dataset["item"];
        if (item) this.hooks.sell(id, item);
        return;
      }
      case "sellGood": {
        const good = target.dataset["good"];
        if (isGoodId(good)) this.hooks.sellGoods(id, good);
        return;
      }
      case "sellGoods":
        this.hooks.sellGoods(id);
        return;
      case "sellAll":
        if (!this.confirming) {
          this.confirming = true;
          this.render();
          return;
        }
        this.confirming = false;
        this.hooks.sellAll(id);
        return;
    }
  }
}
