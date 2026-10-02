/**
 * FVT optional actor sheet for Foundry VTT v14 and Custom System Builder 6.x.
 * This is a presentation layer; the CSB actor remains the source of truth.
 * It intentionally does NOT replace CSB's default editor/template builder.
 */
const MODULE_ID = "fvt-csb-sheet";
const BASE = `modules/${MODULE_ID}`;
const NUMBER_KEYS = new Set([
  "age", "special_s", "special_p", "special_e", "special_c", "special_i",
  "special_a", "special_l", "originium_infection", "originium_resistance",
  "health", "defense", "speed", "initiative", "skill_melee", "skill_ranged",
  "skill_medicine", "skill_survival", "skill_technique", "skill_social", "skill_arts"
]);
const SPECIAL_KEYS = new Set([...NUMBER_KEYS].filter(k => k.startsWith("special_")));
const TEXT_KEYS = new Set(["race", "subrace", "birth_city", "notes", "bio"]);
const ALLOWED_KEYS = new Set([...NUMBER_KEYS, ...TEXT_KEYS]);

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Retain only simple formatting. No attributes, scripts or arbitrary HTML. */
function cleanBiography(input) {
  const template = document.createElement("template");
  template.innerHTML = String(input ?? "");
  const tags = new Set(["P", "BR", "B", "STRONG", "I", "EM", "U", "H2", "UL", "OL", "LI"]);
  const discard = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "FORM"]);
  const walk = node => {
    if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    if (discard.has(node.tagName)) return "";
    const inside = [...node.childNodes].map(walk).join("");
    if (node.tagName === "DIV") return `<p>${inside}</p>`;
    if (node.tagName === "BR") return "<br>";
    return tags.has(node.tagName) ? `<${node.tagName.toLowerCase()}>${inside}</${node.tagName.toLowerCase()}>` : inside;
  };
  return [...template.content.childNodes].map(walk).join("");
}

function normalizeTraitSlots(data) {
  const raw = Array.isArray(data) ? data : [];
  return Array.from({length: 4}, (_, slotIndex) => ({
    index: slotIndex,
    tags: (Array.isArray(raw[slotIndex]) ? raw[slotIndex] : [])
      .filter(tag => tag && typeof tag.text === "string")
      .slice(0, 8).map((tag, index) => ({
        index, slotIndex, text: tag.text.slice(0, 100), negative: Boolean(tag.negative)
      }))
  }));
}

const {api, sheets, apps} = foundry.applications;

class FVTActorSheet extends api.HandlebarsApplicationMixin(sheets.ActorSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["fvt-csb-window"],
    position: {width: 1260, height: 910},
    window: {resizable: true}
  };

  static PARTS = {
    body: {template: `${BASE}/templates/actor-sheet.hbs`}
  };

  _currentTab = "profile";
  _resizeObserver = null;
  _eventsAbort = null;

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const actor = this.actor;
    const props = actor.system?.props ?? {};
    const owned = actor.items.filter(item => item.type === "equippableItem");
    const describe = item => ({
      id: item.id,
      name: item.name,
      description: item.system?.props?.description ?? item.getFlag(MODULE_ID, "description") ?? ""
    });
    return {
      ...context,
      editable: actor.canUserModify(game.user, "update"),
      actorName: actor.name,
      portrait: actor.img || "icons/svg/mystery-man.svg",
      props,
      bioHtml: cleanBiography(props.bio),
      equippedItems: owned.filter(item => item.getFlag(MODULE_ID, "equipped") === true).map(describe),
      backpackItems: owned.filter(item => item.getFlag(MODULE_ID, "equipped") !== true).map(describe),
      traitSlots: normalizeTraitSlots(actor.getFlag(MODULE_ID, "traitSlots"))
    };
  }

  // Field updates are saved explicitly; do not let Foundry's generic form
  // submission overwrite CSB data, or submit on Enter inside the sheet.
  _onChangeForm(formConfig, event) {
    if (event.target?.closest?.(".fvt-sheet")) return;
    return super._onChangeForm(formConfig, event);
  }
  async _onSubmitForm(formConfig, event) {
    event.preventDefault();
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this._resizeObserver?.disconnect();
    this._eventsAbort?.abort();
    this._eventsAbort = new AbortController();
    const signal = this._eventsAbort.signal;
    const root = this.element.querySelector(".fvt-stage");
    if (!root) return;
    const fit = () => {
      const width = this.window.content.clientWidth;
      if (width <= 0) return;
      const scale = Math.min(1, width / 1540);
      root.style.width = `${1540 * scale}px`;
      root.style.height = `${1025 * scale}px`;
      const sheet = root.querySelector(".fvt-sheet");
      if (sheet) sheet.style.transform = `scale(${scale})`;
    };
    fit();
    this._resizeObserver = new ResizeObserver(fit);
    this._resizeObserver.observe(this.window.content);
    this._activateTab(root);
    this._drawInfection(root);

    root.addEventListener("keydown", event => {
      if (event.target.matches("input") && event.key === "Enter" && !event.target.matches(".tag-entry")) {
        event.preventDefault();
        event.target.blur();
      }
    }, {signal});
    root.addEventListener("change", event => {
      const field = event.target;
      if (field.dataset.prop) void this._saveProp(field);
      else if (field.dataset.actorField === "name") void this._saveName(field);
      else if (field.dataset.fvtItemName) void this._saveItemName(field);
      else if (field.dataset.fvtItemDescription) void this._saveItemDescription(field);
    }, {signal});
    root.addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.fvtTab) {
        this._currentTab = button.dataset.fvtTab;
        this._activateTab(root);
      } else if (button.dataset.fvtAction === "portrait") {
        void this._pickPortrait();
      } else if (button.dataset.fvtAdd) {
        void this._addItem(button.dataset.fvtAdd === "equipped");
      } else if (button.dataset.fvtItemOpen) {
        this.actor.items.get(button.dataset.fvtItemOpen)?.sheet?.render({force:true});
      } else if (button.dataset.fvtItemMove) {
        void this._moveItem(button.dataset.fvtItemMove);
      } else if (button.dataset.fvtItemDelete) {
        void this._deleteItem(button.dataset.fvtItemDelete);
      } else if (button.dataset.fvtTraitRemove) {
        void this._removeTrait(button.dataset.fvtTraitRemove);
      } else if (button.dataset.fvtFormat) {
        this._formatBiography(button.dataset.fvtFormat, root);
      }
    }, {signal});
    root.querySelectorAll("[data-fvt-format]").forEach(button =>
      button.addEventListener("mousedown", event => event.preventDefault(), {signal}));
    root.querySelectorAll(".tag-entry").forEach(input => input.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const slot = Number(input.closest(".tag-slot")?.dataset.fvtTraitSlot);
      void this._addTrait(slot, input.value);
    }, {signal}));
    const biography = root.querySelector("[data-fvt-bio]");
    biography?.addEventListener("blur", () => void this._saveBiography(biography), {capture:true, signal});
    biography?.addEventListener("paste", event => {
      // Paste only plain text, avoiding imported styles or scripts.
      event.preventDefault();
      document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
    }, {signal});
  }

  async _onClose(options) {
    this._eventsAbort?.abort();
    this._eventsAbort = null;
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    return super._onClose(options);
  }

  _activateTab(root) {
    root.querySelectorAll("[data-fvt-tab]").forEach(tab =>
      tab.classList.toggle("active", tab.dataset.fvtTab === this._currentTab));
    root.querySelectorAll("[data-fvt-view]").forEach(view =>
      view.classList.toggle("active", view.dataset.fvtView === this._currentTab));
  }

  _drawInfection(root) {
    const track = root.querySelector("[data-fvt-infection]");
    if (!track) return;
    const current = Math.max(0, Math.min(32, Math.round(Number(this.actor.system?.props?.originium_infection) || 0)));
    const editable = this.actor.canUserModify(game.user, "update");
    track.replaceChildren();
    for (let i = 1; i <= 32; i++) {
      const seg = document.createElement("button");
      seg.type = "button";
      seg.className = "infection-segment" + (i <= current ? " filled" : "");
      seg.disabled = !editable;
      seg.title = `${Math.round(i / 32 * 100)}% (правая кнопка — сброс)`;
      if (i <= current) seg.style.background = `hsl(${202 * (1 - (i - 1) / 31)} 58% ${38 + (i - 1) / 31 * 4}%)`;
      seg.addEventListener("click", () => void this.actor.update({"system.props.originium_infection": i === current ? 0 : i}));
      seg.addEventListener("contextmenu", event => {
        event.preventDefault();
        if (editable) void this.actor.update({"system.props.originium_infection": 0});
      });
      track.appendChild(seg);
    }
  }

  async _saveProp(field) {
    if (!this.actor.canUserModify(game.user, "update")) return;
    const key = field.dataset.prop;
    if (!ALLOWED_KEYS.has(key)) return;
    let value = field.value;
    if (NUMBER_KEYS.has(key)) {
      if (!value.trim() || !Number.isFinite(Number(value))) {
        ui.notifications.warn(`Для ${key} требуется число.`);
        field.value = this.actor.system?.props?.[key] ?? "";
        return;
      }
      value = Number(value);
      if (SPECIAL_KEYS.has(key)) {
        value = Math.min(20, Math.max(-5, Math.round(value)));
        field.value = value;
      } else if (key === "age") {
        value = Math.round(value);
      }
    }
    try {
      await this.actor.update({[`system.props.${key}`]: value});
    } catch (error) {
      console.error(`${MODULE_ID}: failed to save ${key}`, error);
      ui.notifications.error(`Не удалось сохранить ${key}. Проверь шаблон CSB.`);
    }
  }

  async _saveName(field) {
    if (this.actor.canUserModify(game.user, "update") && field.value.trim()) {
      await this.actor.update({name: field.value.trim()});
    }
  }

  async _pickPortrait() {
    if (!this.actor.canUserModify(game.user, "update")) return;
    new apps.FilePicker({
      type: "image", current: this.actor.img,
      callback: path => this.actor.update({img: path})
    }).render({force:true});
  }

  async _addItem(equipped) {
    if (!this.actor.canUserModify(game.user, "update")) return;
    const worldItems = game.items.filter(item => item.type === "equippableItem");
    const choices = worldItems.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("");
    const fd = await api.DialogV2.input({
      window: {title: "Добавить предмет CSB"},
      content: `<p>Выберите существующий предмет CSB или создайте пустой и откройте его стандартный лист для выбора шаблона.</p><select name="itemId"><option value="__blank">Новый пустой предмет CSB</option>${choices}</select>`,
      ok: {label: "Добавить"}, rejectClose: false
    });
    if (!fd) return;
    const source = game.items.get(fd.itemId);
    const data = source?.type === "equippableItem" ? source.toObject() : {name: "Новый предмет", type: "equippableItem"};
    delete data._id;
    delete data.folder;
    try {
      const [created] = await this.actor.createEmbeddedDocuments("Item", [data]);
      if (!created) return;
      if (equipped) await created.setFlag(MODULE_ID, "equipped", true);
      if (!source) created.sheet?.render({force:true});
    } catch (error) {
      console.error(`${MODULE_ID}: cannot create item`, error);
      ui.notifications.error("Не удалось создать предмет. Настрой шаблон equippableItem в CSB.");
    }
  }

  async _saveItemName(field) {
    if (!this.actor.canUserModify(game.user, "update")) return;
    const item = this.actor.items.get(field.dataset.fvtItemName);
    if (item && field.value.trim()) await item.update({name: field.value.trim()});
  }

  async _saveItemDescription(field) {
    if (!this.actor.canUserModify(game.user, "update")) return;
    const item = this.actor.items.get(field.dataset.fvtItemDescription);
    if (!item) return;
    if (item.system?.props && Object.hasOwn(item.system.props, "description")) {
      await item.update({"system.props.description": field.value});
    } else {
      await item.setFlag(MODULE_ID, "description", field.value);
    }
  }

  async _moveItem(id) {
    if (!this.actor.canUserModify(game.user, "update")) return;
    const item = this.actor.items.get(id);
    if (item) await item.setFlag(MODULE_ID, "equipped", item.getFlag(MODULE_ID, "equipped") !== true);
  }

  async _deleteItem(id) {
    if (!this.actor.canUserModify(game.user, "update")) return;
    const item = this.actor.items.get(id);
    if (!item) return;
    const yes = await api.DialogV2.confirm({
      window: {title: "Удаление предмета"},
      content: `Удалить «${escapeHtml(item.name)}» из инвентаря персонажа?`,
      rejectClose: false
    });
    if (yes) await this.actor.deleteEmbeddedDocuments("Item", [id]);
  }

  async _addTrait(slotIndex, raw) {
    if (!this.actor.canUserModify(game.user, "update") || !Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 3) return;
    let text = raw.trim();
    if (!text) return;
    const negative = text.startsWith("!");
    if (negative) text = text.slice(1).trim();
    if (!text) return;
    const slots = normalizeTraitSlots(this.actor.getFlag(MODULE_ID, "traitSlots")).map(slot => slot.tags);
    if (slots[slotIndex].length >= 8) return ui.notifications.warn("В одном слоте не больше восьми черт.");
    slots[slotIndex].push({text: text.slice(0, 100), negative});
    await this.actor.setFlag(MODULE_ID, "traitSlots", slots);
  }

  async _removeTrait(address) {
    if (!this.actor.canUserModify(game.user, "update")) return;
    const [slot, index] = address.split(":").map(Number);
    if (!Number.isInteger(slot) || slot < 0 || slot > 3 || !Number.isInteger(index)) return;
    const slots = normalizeTraitSlots(this.actor.getFlag(MODULE_ID, "traitSlots")).map(s => s.tags);
    if (index < 0 || index >= slots[slot].length) return;
    slots[slot].splice(index, 1);
    await this.actor.setFlag(MODULE_ID, "traitSlots", slots);
  }

  _formatBiography(command, root) {
    if (!this.actor.canUserModify(game.user, "update")) return;
    const editor = root.querySelector("[data-fvt-bio]");
    if (command === "h2") document.execCommand("formatBlock", false, "h2");
    else document.execCommand(command, false, null);
    editor?.focus();
  }

  async _saveBiography(editor) {
    if (!this.actor.canUserModify(game.user, "update")) return;
    const cleaned = cleanBiography(editor.innerHTML);
    if (cleaned === (this.actor.system?.props?.bio ?? "")) return;
    try {
      await this.actor.update({"system.props.bio": cleaned});
    } catch (error) {
      console.error(`${MODULE_ID}: cannot save biography`, error);
      ui.notifications.error("Не удалось сохранить биографию. Добавь ключ bio в шаблон CSB.");
    }
  }
}

Hooks.once("init", () => {
  if (game.system.id !== "custom-system-builder") return;
  apps.DocumentSheetConfig.registerSheet(foundry.documents.Actor, MODULE_ID, FVTActorSheet, {
    types: ["character"], label: "FVT — Player Sheet (SVG)", makeDefault: false
  });
  console.log(`${MODULE_ID}: optional character sheet registered`);
});
