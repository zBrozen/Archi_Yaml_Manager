// Interface Lua des packs PopTracker (Tracker, ScriptHost, Archipelago…), écrite en Lua.
// Le code des packs n'a accès à aucun objet JavaScript : il ne voit que des tables Lua, et la seule
// passerelle vers la page est `__js(op, …)`, qui n'échange que des nombres, chaînes et booléens.
// (Un objet JavaScript exposé à Lua laisserait remonter jusqu'au constructeur Function de la page.)
export const PRELUDE = String.raw`
local js = __js
__js = nil
local SEP = "\31"

-- Bibliothèques : pas de fichiers, de processus ni de bytecode (seul du texte Lua est chargé).
io = nil
local os_time, os_clock, os_date, os_difftime = os.time, os.clock, os.date, os.difftime
os = { time = os_time, clock = os_clock, date = os_date, difftime = os_difftime }
local traceback = debug.traceback
debug = { traceback = traceback }
local raw_load = load
load = function(chunk, name, _, env)
  if env ~= nil then return raw_load(chunk, name, "t", env) end
  return raw_load(chunk, name, "t")
end
loadstring = load
dofile, loadfile = nil, nil
-- package.loaded garde sinon les bibliothèques d'origine (debug.getregistry, io, os.exit…).
if package then
  package.loaded.io, package.loaded.os, package.loaded.debug = nil, os, debug
  package.loadlib, package.searchpath, package.cpath, package.searchers = nil, nil, "", {}
end

print = function(...)
  local parts = {}
  for i = 1, select("#", ...) do parts[#parts + 1] = tostring((select(i, ...))) end
  js("print", table.concat(parts, "\t"))
end

local function split(s)
  local out = {}
  if s == nil or s == "" then return out end
  for part in (s .. SEP):gmatch("(.-)" .. SEP) do out[#out + 1] = part end
  return out
end

PopVersion = "0.32.0"
AccessibilityLevel = { None = 0, Partial = 1, Inspect = 3, SequenceBreak = 5, Normal = 6, Cleared = 7 }
Highlight = { Avoid = -1, None = 0, NoPriority = 1, Unspecified = 2, Priority = 3 }

-- Scripts du pack ------------------------------------------------------------------

local function run_file(path, ...)
  local src = js("read", path)
  if src == nil then error("script introuvable : " .. tostring(path), 2) end
  local f, err = raw_load(src, "@" .. path, "t")
  if not f then error(err, 0) end
  return f(...)
end

ScriptHost = {}
function ScriptHost:LoadScript(path)
  run_file(path)
  return true
end

local loaded = {}
require = function(name)
  if loaded[name] ~= nil then return loaded[name] end
  local base = name:gsub("%.", "/")
  for _, path in ipairs({ "scripts/" .. base .. ".lua", "scripts/" .. base .. "/init.lua", base .. ".lua", base .. "/init.lua" }) do
    if js("exists", path) then
      local result = run_file(path, name)
      if result == nil then result = true end
      loaded[name] = result
      return result
    end
  end
  error("module introuvable : " .. tostring(name), 2)
end

-- Objets du tracker : tables Lua dont chaque propriété est lue ou écrite par la page.

local wrappers = {}
local function wrap(kind, id)
  local key = kind .. SEP .. id
  local w = wrappers[key]
  if w then return w end
  w = setmetatable({}, {
    __index = function(_, k)
      if k == "Owner" then return {} end
      if k == "SetOverlay" then return function(self, v) js("set", kind, id, "BadgeText", tostring(v or "")) end end
      if k == "SetOverlayColor" then return function(self, v) js("set", kind, id, "BadgeTextColor", tostring(v or "")) end end
      if k == "SetOverlayBackground" then return function(self, v) js("set", kind, id, "OverlayBackground", tostring(v or "")) end end
      if k == "SetOverlayFontSize" then return function(self, v) js("set", kind, id, "OverlayFontSize", tonumber(v) or 0) end end
      if k == "SetOverlayAlign" then return function(self, v) js("set", kind, id, "OverlayAlign", tostring(v or "")) end end
      return js("get", kind, id, k)
    end,
    __newindex = function(_, k, v)
      if type(v) == "table" or type(v) == "function" then v = nil end
      js("set", kind, id, k, v)
    end,
    __tostring = function() return kind .. ":" .. id end,
  })
  wrappers[key] = w
  return w
end

-- Objets personnalisés (ScriptHost:CreateLuaItem) : entièrement en Lua, la page n'en connaît que l'affichage.
local lua_items = {}
local DISPLAY = { Name = true, Icon = true, IconMods = true, BadgeText = true, BadgeTextColor = true }

local function lua_can_provide(item, code)
  local store = item.__store
  if type(store.PotentialCodes) == "table" then
    for _, c in ipairs(store.PotentialCodes) do if c == code then return true end end
    return false
  end
  if store.CanProvideCodeFunc then return store.CanProvideCodeFunc(item.__self, code) and true or false end
  return false
end

local watches = {}
local function notify_watches(code_list, can_provide)
  for name, watch in pairs(watches) do
    local hit = watch.code == "*"
    if not hit then
      if can_provide then hit = can_provide(watch.code)
      else for _, c in ipairs(code_list) do if c == watch.code then hit = true break end end end
    end
    if hit then
      local ok, err = pcall(watch.callback, watch.code)
      if not ok then js("error", "watch " .. tostring(name) .. " : " .. tostring(err)) end
    end
  end
end

local function lua_item_changed(entry)
  js("luaitem_changed", entry.id)
  notify_watches(nil, function(code) return lua_can_provide(entry, code) end)
end

function ScriptHost:CreateLuaItem()
  local entry = { id = #lua_items + 1, __store = { Name = "", Icon = "", IconMods = "", BadgeText = "", BadgeTextColor = "", Type = "custom" } }
  local store = entry.__store
  local methods = {
    Set = function(self, key, value)
      local state = store.ItemState
      if type(state) ~= "table" then state = {} store.ItemState = state end
      if state[key] == value then return false end
      state[key] = value
      if store.PropertyChangedFunc then store.PropertyChangedFunc(self, key, value) end
      lua_item_changed(entry)
      return true
    end,
    Get = function(self, key)
      local state = store.ItemState
      if type(state) ~= "table" then return nil end
      return state[key]
    end,
    SetOverlay = function(self, v) store.BadgeText = tostring(v or "") js("luaitem_changed", entry.id) end,
    SetOverlayColor = function(self, v) store.BadgeTextColor = tostring(v or "") js("luaitem_changed", entry.id) end,
    SetOverlayBackground = function() end,
    SetOverlayFontSize = function() end,
    SetOverlayAlign = function() end,
  }
  local item = setmetatable({}, {
    __index = function(_, k)
      if methods[k] then return methods[k] end
      if k == "Owner" then return {} end
      return store[k]
    end,
    __newindex = function(_, k, v)
      if store[k] == v then return end
      store[k] = v
      if DISPLAY[k] then lua_item_changed(entry) end
    end,
  })
  entry.__self = item
  lua_items[entry.id] = entry
  js("luaitem_created", entry.id)
  return item
end

local function find_lua_item(code)
  for _, entry in ipairs(lua_items) do
    if lua_can_provide(entry, code) then return entry end
  end
  return nil
end

-- Appelées par la page.
function __pt_lua_find(code)
  local entry = find_lua_item(code)
  return entry and entry.id or nil
end

function __pt_lua_provides(code)
  local total = 0
  for _, entry in ipairs(lua_items) do
    if lua_can_provide(entry, code) and entry.__store.ProvidesCodeFunc then
      local n = entry.__store.ProvidesCodeFunc(entry.__self, code)
      if n == true then n = 1 elseif not n then n = 0 end
      total = total + (tonumber(n) or 0)
    end
  end
  return total
end

function __pt_lua_item_view(id)
  local store = lua_items[id].__store
  return table.concat({ tostring(store.Name or ""), tostring(store.Icon or ""), tostring(store.IconMods or ""),
    tostring(store.BadgeText or ""), tostring(store.BadgeTextColor or "") }, SEP)
end

function __pt_lua_item_click(id, button)
  local entry = lua_items[id]
  local store = entry.__store
  if store.IgnoreUserInput then return end
  local f = button == 2 and store.OnRightClickFunc or button == 1 and store.OnMiddleClickFunc or store.OnLeftClickFunc
  if f then f(entry.__self) end
end

function __pt_item_changed(codes)
  notify_watches(split(codes))
end

function __pt_rule(name, args)
  local f = _G[name]
  if type(f) ~= "function" then
    js("error", "fonction de règle introuvable : " .. tostring(name))
    return 0
  end
  local result = f(table.unpack(split(args)))
  if result == true then return 1 end
  if not result then return 0 end
  return math.floor(tonumber(result) or 0)
end

-- Tracker ---------------------------------------------------------------------------

Tracker = setmetatable({}, {
  __index = function(_, k) return js("tracker_get", k) end,
  __newindex = function(_, k, v) js("tracker_set", k, v) end,
})
for _, op in ipairs({ "AddItems", "AddMaps", "AddLocations", "AddLayouts", "AddClasses" }) do
  rawset(Tracker, op, function(self, path) return js(op, path) end)
end
rawset(Tracker, "ProviderCountForCode", function(self, code)
  return js("count", tostring(code)) + __pt_lua_provides(tostring(code))
end)
rawset(Tracker, "FindObjectForCode", function(self, code)
  code = tostring(code)
  local found = js("find", code)
  if found then
    local kind, id = found:match("^(%a+):(.*)$")
    return wrap(kind, id)
  end
  local entry = find_lua_item(code)
  return entry and entry.__self or nil
end)
rawset(Tracker, "UiHint", function(self, name, value) js("uihint", tostring(name), tostring(value)) end)
rawset(Tracker, "OpenLink", function() return false end)

function ScriptHost:AddWatchForCode(name, code, callback)
  watches[name] = { code = code, callback = callback }
  js("watching")
  return name
end
function ScriptHost:RemoveWatchForCode(name) watches[name] = nil return true end

local section_handlers = {}
function ScriptHost:AddOnLocationSectionChangedHandler(name, callback) section_handlers[name] = callback return name end
function ScriptHost:RemoveOnLocationSectionChangedHandler(name) section_handlers[name] = nil return true end
ScriptHost.RemoveOnLocationSectionHandler = ScriptHost.RemoveOnLocationSectionChangedHandler
function __pt_section_changed(id)
  local section = wrap("section", id)
  for name, callback in pairs(section_handlers) do
    local ok, err = pcall(callback, section)
    if not ok then js("error", "section " .. tostring(name) .. " : " .. tostring(err)) end
  end
end

local frame_handlers = {}
function ScriptHost:AddOnFrameHandler(name, callback) frame_handlers[name] = callback return name end
function ScriptHost:RemoveOnFrameHandler(name) frame_handlers[name] = nil return true end
-- Lecture de la mémoire du jeu : sans objet dans le navigateur.
function ScriptHost:AddMemoryWatch() return nil end
function ScriptHost:RemoveMemoryWatch() return true end
function ScriptHost:AddVariableWatch() return nil end
function ScriptHost:RemoveVariableWatch() return true end
function ScriptHost:RunScriptAsync(path, arg, done)
  _G.arg = arg
  local result = run_file(path)
  if done then done(result) end
end
function ScriptHost:RunStringAsync(src, arg, done)
  _G.arg = arg
  local f = assert(raw_load(src, "=async", "t"))
  local result = f()
  if done then done(result) end
end
function ScriptHost:AsyncProgress() end

ImageReference = {}
function ImageReference:FromPackRelativePath(path) return path end
function ImageReference:FromImageReference(original, mods)
  if mods == nil or mods == "" then return original end
  if tostring(original):find(":") then return original .. "," .. mods end
  return original .. ":" .. mods
end

AutoTracker = {}
function AutoTracker:GetConnectionState(name)
  if name == "AP" then return js("ap_state") end
  return 0
end
function AutoTracker:ReadU8() return 0 end
function AutoTracker:ReadU16() return 0 end
function AutoTracker:ReadU24() return 0 end
function AutoTracker:ReadU32() return 0 end

-- Archipelago -----------------------------------------------------------------------

local handlers = { clear = {}, item = {}, location = {}, scout = {}, bounced = {}, retrieved = {}, setreply = {} }
Archipelago = {
  PlayerNumber = -1, TeamNumber = -1, CheckedLocations = {}, MissingLocations = {}, Seed = nil,
  ClientStatus = { UNKNOWN = 0, CONNECTED = 5, READY = 10, PLAYING = 20, GOAL = 30 },
}
local function adder(kind) return function(self, name, callback) handlers[kind][name] = callback return true end end
Archipelago.AddClearHandler = adder("clear")
Archipelago.AddItemHandler = adder("item")
Archipelago.AddLocationHandler = adder("location")
Archipelago.AddScoutHandler = adder("scout")
Archipelago.AddBouncedHandler = adder("bounced")
Archipelago.AddRetrievedHandler = adder("retrieved")
Archipelago.AddSetReplyHandler = adder("setreply")
local function keys_of(keys)
  local out = {}
  for _, k in ipairs(keys or {}) do out[#out + 1] = tostring(k) end
  return table.concat(out, SEP)
end
function Archipelago:Get(keys) return js("ap_get", keys_of(keys)) end
function Archipelago:SetNotify(keys) return js("ap_notify", keys_of(keys)) end
function Archipelago:GetPlayerAlias(slot) return js("ap_player", tonumber(slot) or -1, "alias") end
function Archipelago:GetPlayerGame(slot) return js("ap_player", tonumber(slot) or -1, "game") end
function Archipelago:GetItemName(id, game) return js("ap_name", "item", tonumber(id) or 0, game and tostring(game) or "") end
function Archipelago:GetLocationName(id, game) return js("ap_name", "location", tonumber(id) or 0, game and tostring(game) or "") end
-- Le site ne fait que suivre la partie : rien n'est envoyé au serveur.
function Archipelago:LocationChecks() return false end
function Archipelago:LocationScouts() return false end
function Archipelago:StatusUpdate() return false end

local function value_of(literal)
  if literal == nil or literal == "" then return nil end
  return assert(raw_load("return " .. literal, "=data", "t", {}))()
end

function __pt_ap_state(player, team, seed, checked, missing)
  Archipelago.PlayerNumber = player
  Archipelago.TeamNumber = team
  Archipelago.Seed = seed ~= "" and seed or nil
  Archipelago.CheckedLocations = value_of(checked) or {}
  Archipelago.MissingLocations = value_of(missing) or {}
end

function __pt_ap_checked(id)
  table.insert(Archipelago.CheckedLocations, id)
  for i, v in ipairs(Archipelago.MissingLocations) do
    if v == id then table.remove(Archipelago.MissingLocations, i) break end
  end
end

local function dispatch(kind, ...)
  for name, callback in pairs(handlers[kind]) do
    local ok, err = pcall(callback, ...)
    if not ok then js("error", kind .. " " .. tostring(name) .. " : " .. tostring(err)) end
  end
end

function __pt_ap(kind, a, b, c, d, e)
  if kind == "clear" then dispatch("clear", value_of(a) or {})
  elseif kind == "item" then dispatch("item", a, b, c, d)
  elseif kind == "location" then dispatch("location", a, b)
  elseif kind == "scout" then dispatch("scout", a, b, c, d, e)
  elseif kind == "bounced" then dispatch("bounced", value_of(a) or {})
  elseif kind == "retrieved" then dispatch("retrieved", a, value_of(b))
  elseif kind == "setreply" then dispatch("setreply", a, value_of(b), value_of(c))
  end
end

function __pt_run(path) run_file(path) end
`;

// Valeur JSON écrite en Lua (lue de l'autre côté par load en mode texte, dans un environnement vide).
export function toLua(value) {
  if (value === null || value === undefined) return "nil";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0";
  if (typeof value === "string") {
    return `"${value.replace(/[\\"\x00-\x1f\x7f]/g, (c) => {
      if (c === "\\") return "\\\\";
      if (c === '"') return '\\"';
      if (c === "\n") return "\\n";
      return `\\${String(c.charCodeAt(0)).padStart(3, "0")}`;
    })}"`;
  }
  if (Array.isArray(value)) return `{${value.map(toLua).join(",")}}`;
  return `{${Object.entries(value).map(([k, v]) => `[${toLua(k)}]=${toLua(v)}`).join(",")}}`;
}
