const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const bundle = fs.readFileSync(path.join(__dirname,
  '../ComfyUI Photoshop Team/dist/assets/index-B_-tWO9a.js'), 'utf8');
const upstream = 'https://github.com/NimaNzrii/comfyui-photoshop';

// Run the shipped component functions, not a reimplementation of their
// conditional markup. The DOM and unrelated Settings controls are local stubs;
// this does not start Photoshop, navigate a WebView, or issue network requests.
function compiled(start, end) {
  const first = bundle.indexOf(start), last = bundle.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Compiled fragment missing: ${start}`);
  return bundle.slice(first, last);
}
function node(tag, text = '') {
  return {tag, text: String(text), attrs: {}, style: {}, children: [], parentNode: null};
}
function insert(parent, child, anchor = null) {
  if (child.parentNode) remove(child);
  const index = anchor == null ? -1 : parent.children.indexOf(anchor);
  if (index < 0) parent.children.push(child);
  else parent.children.splice(index, 0, child);
  child.parentNode = parent;
}
function remove(child) {
  if (!child.parentNode) return;
  const siblings = child.parentNode.children;
  siblings.splice(siblings.indexOf(child), 1);
  child.parentNode = null;
}
function descendants(root, predicate) {
  return root.children.flatMap(child => [
    ...(predicate(child) ? [child] : []), ...descendants(child, predicate)
  ]);
}
function textContent(root) {
  return root.tag === '#text' ? root.text : root.children.map(textContent).join('');
}
function harness() {
  class Control {
    constructor() { this.$$ = {fragment: {c() {}, m() {}, p() {}, d() {}}}; }
    $set() {}
    $on() {}
  }
  const context = vm.createContext({
    L: tag => node(tag), K: value => node('#text', value),
    N: () => node('#text', ' '), bt: () => node('#text'),
    O: (element, name, value) => { element.attrs[name] = value; },
    te: (element, name, value) => { element.style[name] = value; },
    R: insert, $: insert, M: remove, Z: (element, value) => { element.text = String(value); },
    V: fragment => fragment.c(), F: (component, parent, anchor) => component.$$.fragment.m(parent, anchor),
    le() {}, Q: [], Oe: Control, Le: Control, $m() {}, Cm() {}, me() {}
  });
  vm.runInContext(compiled('function Jr(', 'class zn extends') +
    compiled('function Sm(', 'function km('), context);
  class Header {
    constructor({props}) {
      this.dirty = 0;
      this.values = context.$g(this, props, (index, value) => {
        this.values[index] = value;
        this.dirty |= 1 << index;
        return value;
      });
      this.$$ = {fragment: context.wg(this.values)};
    }
    $set(props) {
      this.dirty = 0;
      this.$$set(props);
      this.$$.fragment.p(this.values, [this.dirty]);
    }
  }
  context.zn = Header;
  return {context, Header};
}
function mount(fragment) {
  const root = node('root');
  fragment.c(); fragment.m(root, null);
  return root;
}
function connection(status, color) {
  const {context} = harness();
  const state = [];
  state[0] = {};
  state[3] = {t: key => ({comfyUIIP: 'ComfyUI IP', ipAddress: 'IP Address'})[key] || key};
  state[8] = {status, color};
  const fragment = context.Sm(state), root = mount(fragment);
  return {root, update(status, color) {
    state[8] = {status, color};
    fragment.p(state, [256, 0]);
  }};
}
function connectionStatus(root) {
  const headers = descendants(root, element => element.attrs.class === 'header svelte-7o6noh');
  assert.equal(headers.length, 1);
  const header = headers[0];
  assert.equal(descendants(header, element => element.tag === 'a').length, 0,
    'Connection status must not be rendered inside a clickable anchor');
  const statuses = descendants(header, element => element.attrs.class === 'header_discrip discrip svelte-7o6noh');
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].tag, 'span');
  assert.equal(statuses[0].parentNode, header);
  assert.equal(Object.hasOwn(statuses[0].attrs, 'href'), false);
  return statuses[0];
}

test('actual Settings connection errors, loading, and Connected render colored non-link status spans', () => {
  for (const [status, color] of [
    ['Web panel load error (-105)', 'darkred'],
    ['Connection: Web panel is unavailable', 'darkred'],
    ['Loading Web panel', 'orange'],
    ['Connected', 'green']
  ]) {
    const element = connectionStatus(connection(status, color).root);
    assert.equal(textContent(element), status);
    assert.equal(element.style.color, color);
  }
});

test('actual Settings connection status keeps text and color live without becoming a link', () => {
  const panel = connection('Web panel load error (-105)', 'darkred');
  const original = connectionStatus(panel.root);
  for (const [status, color] of [
    ['Loading Web panel', 'orange'], ['Connected', 'green'],
    ['Connection: Session expired', 'darkred']
  ]) {
    panel.update(status, color);
    const current = connectionStatus(panel.root);
    assert.equal(current, original, 'Status updates should reuse the same span');
    assert.equal(textContent(current), status);
    assert.equal(current.style.color, color);
  }
});

test('actual default help header retains the original upstream hyperlink', () => {
  const {Header} = harness();
  const header = new Header({props: {title: 'Prompt'}});
  const root = mount(header.$$.fragment);
  const anchors = descendants(root, element => element.tag === 'a');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].attrs.href, upstream);
  assert.equal(textContent(anchors[0]), 'Need Help?');
  assert.equal(anchors[0].children[0].style.color, '#696969');
  header.$set({status: 'Help', statusColor: 'orange'});
  assert.equal(anchors[0].attrs.href, upstream);
  assert.equal(textContent(anchors[0]), 'Help');
  assert.equal(anchors[0].children[0].style.color, 'orange');
});

test('explicit header links and original attribution/support URL literals are preserved', () => {
  const {Header} = harness();
  const header = new Header({props: {title: 'Support', status: 'Report an issue', link: `${upstream}/issues/new`}});
  const root = mount(header.$$.fragment);
  assert.equal(descendants(root, element => element.tag === 'a')[0].attrs.href, `${upstream}/issues/new`);
  assert.ok(bundle.includes(`{link:r="${upstream}"}`));
  assert.ok(bundle.includes(`"href","${upstream}/issues/new"`));
  assert.ok(bundle.includes('"href","https://discord.gg/mh5P4hY7"'));
});
