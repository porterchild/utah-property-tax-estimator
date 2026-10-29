// Minimal DOM stand-in so the app script from the shipped HTML can run under Node and be smoke tested.
// Only the handful of APIs the page actually uses are implemented.
export function createDom(ids = []) {
  const listeners = new Map();
  const made = new Map();
  const madeEls = [];
  function make(tag) {
    const el = {
      tagName: String(tag || "div").toUpperCase(),
      value: "", checked: false, textContent: "", hidden: false, disabled: false, type: "",
      _html: "", children: [], firstChild: null, style: {},
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener(t, fn) {
        const key = el.id + ":" + t;
        if (!listeners.has(key)) listeners.set(key, []);
        listeners.get(key).push(fn);
      },
      appendChild(c) { this.children.push(c); this.firstChild = this.children[0]; return c; },
      // Children are appended after whatever innerHTML was assigned, so readers of innerHTML see
      // both — that is how the picker buttons become visible to the smoke tests.
      get innerHTML() {
        return this._html + this.children.map((c) => c.outerHTML).join("");
      },
      get outerHTML() { return "<" + this.tagName.toLowerCase() + ">" + this.innerHTML + "</" + this.tagName.toLowerCase() + ">"; },
      set innerHTML(v) { this._html = String(v); this.children = []; this.firstChild = null; },
      focus() {}, select() {}, setSelectionRange() {}, scrollIntoView() {}
    };
    madeEls.push(el);
    return el;
  }
  const document = {
    getElementById(id) {
      if (!made.has(id)) { const el = make("div"); el.id = id; made.set(id, el); }
      return made.get(id);
    },
    createElement(tag) { const el = make(tag); el.id = "generated"; return el; },
    createRange() { return { selectNodeContents() {} }; },
    addEventListener() {}
  };
  const window = {
    localStorage: {
      _v: new Map(),
      getItem(k) { return this._v.has(k) ? this._v.get(k) : null; },
      setItem(k, v) { this._v.set(k, String(v)); }
    },
    getSelection() { return { removeAllRanges() {}, addRange() {} }; }
  };
  const navigator = { clipboard: { writeText: async () => {} } };
  function fire(id, type, event) {
    const list = listeners.get(id + ":" + type) || [];
    list.forEach((fn) => fn.call(document.getElementById(id), Object.assign({ preventDefault() {} }, event)));
    return list.length;
  }
  return { document, window, navigator, made, madeEls, fire, el: (id) => document.getElementById(id) };
}
