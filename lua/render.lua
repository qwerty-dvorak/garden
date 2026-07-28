-- render.lua — every page shape lives here.
-- Edit and refresh. No recompile. C hands you a table, you hand back a string.

render = {}

local function esc(s)
  if not s or s == "" then return "" end
  return (s:gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;")
           :gsub('"', "&quot;"):gsub("'", "&#39;"))
end

-- CSS goes in a <style> element, so the only thing that can escape it is a
-- closing tag. Kill angle brackets and it is inert.
local function csssafe(s)
  if not s or s == "" then return "" end
  return (s:gsub("[<>]", ""))
end

-- C only pushes header fields that actually exist, so anything optional
-- arrives as nil. Never index a block field directly.
local function f(t, k) return t[k] or "" end

-- A skin name becomes a path, so it gets id rules, not string rules.
local function safeid(s)
  if not s or not s:match("^[%w_%-]+$") then return "" end
  return s
end

-- A font url becomes a src. Site-relative only: no scheme, no host, no
-- traversal. Same rule the C side applies to media src.
local function safepath(s)
  if not s or s == "" then return "" end
  if s:sub(1, 1) ~= "/" or s:find("//", 1, true) or s:find("%.%.") then return "" end
  if s:find('[<>"\']') then return "" end
  return s
end

-- every knob defaults to "" so shell() can test them without nil checks
local KNOBS = { "skin","font","fontsrc","size","measure","ink","paper","rule","step",
                "css","class","leading","tracking","weight","align","columns",
                "scroll","js","wasm" }
local function defaults(o)
  for _, k in ipairs(KNOBS) do o[k] = o[k] or "" end
  return o
end

local NAV = {
  { "/",                "index"         },
  { "/tags",            "tags"          },
  { "/contradictions",  "contradictions"},
  { "/mnt",             "mounts"        },
}

--------------------------------------------------------------------------
-- the shell. nav, footer, and the freedom knobs.
--------------------------------------------------------------------------
-- Per-page overrides, all optional, all set in the block header:
--
--   skin     austere          -> loads /skins/austere.css
--   font     "Iosevka", mono  -> body font-family
--   fontsrc  /fonts/x.woff2   -> @font-face, then use `font  pageface`
--   size     1.4rem           -> body font-size
--   measure  22rem            -> line length
--   ink      #f0e            -> text colour
--   paper    #000             -> background
--   css      any css at all   -> injected verbatim (minus angle brackets)
--   class    loud shrine      -> extra classes on <body>
--
-- A page may ignore every one of these, or use all of them and look like
-- nothing else on the site. That's the point.
local function shell(o)
  local out = {}
  out[#out+1] = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
  out[#out+1] = '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
  out[#out+1] = '<title>' .. esc(o.title) .. '</title>\n'
  out[#out+1] = '<link rel="stylesheet" href="/base.css">\n'
  out[#out+1] = '<link rel="stylesheet" href="/fonts.css">\n'
  local skin = safeid(o.skin)
  if skin ~= "" then
    out[#out+1] = '<link rel="stylesheet" href="/skins/' .. skin .. '.css">\n'
  end

  local rules = {}
  local fontsrc = safepath(o.fontsrc)
  if fontsrc ~= "" then
    out[#out+1] = '<style>@font-face{font-family:pageface;src:url("'
      .. fontsrc .. '");font-display:swap}</style>\n'
  end
  if o.font    ~= "" then rules[#rules+1] = "--body: "    .. csssafe(o.font)    end
  if o.measure ~= "" then rules[#rules+1] = "--measure: " .. csssafe(o.measure) end
  if o.ink     ~= "" then rules[#rules+1] = "--ink: "     .. csssafe(o.ink)     end
  if o.paper   ~= "" then rules[#rules+1] = "--paper: "   .. csssafe(o.paper)   end
  if o.rule    ~= "" then rules[#rules+1] = "--rule: "    .. csssafe(o.rule)    end
  if o.step    ~= "" then rules[#rules+1] = "--step: "    .. csssafe(o.step)    end
  if #rules > 0 then
    out[#out+1] = '<style>:root{' .. table.concat(rules, ";") .. '}</style>\n'
  end
  local body_rules = {}
  if o.size    ~= "" then body_rules[#body_rules+1] = "font-size:"      .. csssafe(o.size)    end
  if o.leading ~= "" then body_rules[#body_rules+1] = "line-height:"    .. csssafe(o.leading) end
  if o.tracking~= "" then body_rules[#body_rules+1] = "letter-spacing:" .. csssafe(o.tracking)end
  if o.weight  ~= "" then body_rules[#body_rules+1] = "font-weight:"    .. csssafe(o.weight)  end
  if o.align   ~= "" then body_rules[#body_rules+1] = "text-align:"     .. csssafe(o.align)   end
  if #body_rules > 0 then
    out[#out+1] = '<style>body{' .. table.concat(body_rules, ";") .. '}</style>\n'
  end
  if o.columns ~= "" then
    out[#out+1] = '<style>article{column-count:' .. csssafe(o.columns)
      .. ';column-gap:2.5rem;column-rule:1px solid var(--rule)}</style>\n'
  end
  if o.css ~= "" then
    out[#out+1] = '<style>' .. csssafe(o.css) .. '</style>\n'
  end

  local bodycls = o.class
  if o.scroll == "reverse"    then bodycls = bodycls .. " scroll-reverse"    end
  if o.scroll == "horizontal" then bodycls = bodycls .. " scroll-horizontal" end
  out[#out+1] = '</head>\n<body class="' .. esc(bodycls) .. '">\n<nav>'
  for _, n in ipairs(NAV) do
    out[#out+1] = '<a href="' .. n[1] .. '">' .. n[2] .. '</a>'
  end
  out[#out+1] = '</nav>\n'
  out[#out+1] = o.body
  out[#out+1] = '\n<footer><a href="/">garden</a>'
  out[#out+1] = '<a href="/tags">tags</a>'
  out[#out+1] = '<a href="https://creativecommons.org/licenses/by-nc-sa/4.0/">BY-NC-SA</a>'
  out[#out+1] = '</footer>\n'
  if o.scroll == "reverse" or o.scroll == "horizontal" then
    out[#out+1] = '<script src="/js/scroll.js"></script>\n'
  end
  local js = safeid(o.js)
  if js ~= "" then out[#out+1] = '<script src="/js/' .. js .. '.js"></script>\n' end
  if safeid(o.wasm) ~= "" then out[#out+1] = '<script src="/js/wasm.js"></script>\n' end
  out[#out+1] = '</body>\n</html>\n'
  return table.concat(out)
end

-- a plain page with no per-page overrides
local function page(title, body)
  return shell(defaults({ title = title, body = body }))
end

--------------------------------------------------------------------------
-- pieces
--------------------------------------------------------------------------

local function taglinks(tags)
  local out = {}
  for tag in tags:gmatch("%S+") do
    out[#out+1] = '<a href="/tag/' .. esc(tag) .. '">' .. esc(tag) .. '</a>'
  end
  return table.concat(out, " ")
end

-- how old is this, what kind of thing is it, does it show
local function stageline(b)
  local bits = {}
  for _, k in ipairs({ "stage", "date", "type" }) do
    if f(b, k) ~= "" then bits[#bits+1] = esc(f(b, k)) end
  end
  local line = '<p class="stage">' .. table.concat(bits, " · ")
  if f(b, "tags") ~= "" then
    line = line .. (#bits > 0 and " · " or "") .. taglinks(f(b, "tags"))
  end
  if #bits == 0 and f(b, "tags") == "" then return "" end
  return line .. '</p>\n'
end

local function blocklist(blocks)
  local out = { '<ul class="index">\n' }
  for _, b in ipairs(blocks) do
    out[#out+1] = '<li><a href="/b/' .. esc(f(b, "id")) .. '">' .. esc(f(b, "title")) .. '</a>'
    out[#out+1] = ' <span class="stage">' .. esc(f(b, "type"))
    if f(b, "date") ~= "" then out[#out+1] = ' · ' .. esc(f(b, "date")) end
    out[#out+1] = '</span></li>\n'
  end
  out[#out+1] = '</ul>\n'
  return table.concat(out)
end

--------------------------------------------------------------------------
-- pages
--------------------------------------------------------------------------

-- a single block. `body` arrives already parsed and escaped by loam.c.
function render.block(b)
  local title = f(b, "title") ~= "" and f(b, "title") or f(b, "id")
  local out = {}
  out[#out+1] = '<article class="' .. esc(f(b, "type")) .. '">\n'
  out[#out+1] = '<h1>' .. esc(title) .. '</h1>\n'
  out[#out+1] = stageline(b)

  -- a very long page needs a way in that isn't scrolling
  b.toc = b.toc or {}
  if #b.toc >= 3 and (b.bytes or 0) > 3000 then
    out[#out+1] = '<nav class="toc"><b>contents</b><ol>\n'
    for _, h in ipairs(b.toc) do
      out[#out+1] = '<li><a href="#' .. esc(f(h, "id")) .. '">' .. esc(f(h, "text")) .. '</a></li>\n'
    end
    out[#out+1] = '</ol></nav>\n'
  end

  out[#out+1] = f(b, "body")
  local w = safeid(f(b, "wasm"))
  if w ~= "" then
    out[#out+1] = '<div class="wasm" data-wasm="' .. w .. '"></div>\n'
    out[#out+1] = '<noscript><p class="stage">This block is a wasm module; '
      .. 'it needs javascript to run. The C source is in <code>src/wasm/'
      .. w .. '.c</code>.</p></noscript>\n'
  end
  out[#out+1] = '</article>\n<hr>\n'

  b.incoming = b.incoming or {}
  out[#out+1] = '<div class="incoming">incoming:'
  if #b.incoming == 0 then
    out[#out+1] = ' <em>nothing points here yet</em>'
  else
    out[#out+1] = '<ul>'
    for _, i in ipairs(b.incoming) do
      out[#out+1] = '<li><a href="/b/' .. esc(f(i, "id")) .. '">' .. esc(f(i, "title")) .. '</a></li>'
    end
    out[#out+1] = '</ul>'
  end
  out[#out+1] = '</div>\n'

  local o = { title = title, body = table.concat(out) }
  for _, k in ipairs(KNOBS) do o[k] = f(b, k) end
  return shell(o)
end

-- home. everything is a block, so home is just a view over them.
function render.home(d)
  local by = {}
  for _, b in ipairs(d.blocks) do
    local t = f(b, "type")
    by[t] = by[t] or {}
    table.insert(by[t], b)
  end

  local out = {}
  out[#out+1] = '<h1>garden</h1>\n'
  out[#out+1] = '<p>' .. #d.blocks .. ' blocks. nothing here is finished.</p>\n'

  local ORDER = { "note", "poem", "quote", "collection", "audio", "video", "image", "link" }
  for _, t in ipairs(ORDER) do
    if by[t] then
      out[#out+1] = '<h2>' .. esc(t) .. '</h2>\n' .. blocklist(by[t])
      by[t] = nil
    end
  end
  for t, list in pairs(by) do
    out[#out+1] = '<h2>' .. esc(t) .. '</h2>\n' .. blocklist(list)
  end

  return page("garden", table.concat(out))
end

function render.tags(d)
  local out = { '<h1>tags</h1>\n<ul class="index">\n' }
  for _, t in ipairs(d.tags) do
    out[#out+1] = '<li><a href="/tag/' .. esc(f(t, "tag")) .. '">' .. esc(f(t, "tag"))
      .. '</a> <span class="stage">' .. tostring(t.n) .. '</span></li>\n'
  end
  out[#out+1] = '</ul>\n'
  return page("tags", table.concat(out))
end

function render.tag(d)
  local body = '<h1>' .. esc(f(d, "tag")) .. '</h1>\n' .. blocklist(d.blocks)
  return page(f(d, "tag"), body)
end

-- your hypocrisy, indexed and on purpose
function render.contradictions(d)
  local out = { '<h1>contradictions</h1>\n' }
  d.pairs = d.pairs or {}
  if #d.pairs == 0 then
    out[#out+1] = '<p>Nothing here disagrees with anything yet. Add <code>contra</code> to a block header.</p>\n'
  end
  for _, p in ipairs(d.pairs) do
    out[#out+1] = '<div class="contra">\n'
    for _, side in ipairs({ p.left, p.right }) do
      out[#out+1] = '<div class="side"><h3><a href="/b/' .. esc(f(side, "id")) .. '">'
        .. esc(f(side, "title")) .. '</a></h3>\n' .. f(side, "body") .. '</div>\n'
    end
    out[#out+1] = '</div>\n'
  end
  return shell(defaults({ title = "contradictions", body = table.concat(out), class = "wide" }))
end

-- filenames in a mounted folder are arbitrary: spaces, brackets, #, &.
-- Anything not unreserved gets percent-encoded, / kept as the separator.
local function urlenc(s)
  return (s:gsub("[^%w%-%_%.%~/]", function (c)
    return string.format("%%%02X", string.byte(c))
  end))
end

local function human(n)
  n = n or 0
  if n > 1073741824 then return string.format("%.1fG", n/1073741824) end
  if n > 1048576    then return string.format("%.1fM", n/1048576)    end
  if n > 1024       then return string.format("%.0fK", n/1024)       end
  return tostring(math.floor(n)) .. "B"
end

-- a mounted folder, listed. the only place the site shows a directory.
function render.dir(d)
  local mount, rel = f(d, "mount"), f(d, "rel")
  local base = "/mnt/" .. mount .. "/"
  local out = { '<h1>', esc(mount), rel ~= "" and ('/' .. esc(rel)) or "", '</h1>\n' }
  out[#out+1] = '<p class="stage"><a href="/mnt">mounts</a>'
  if rel ~= "" then
    local acc = ""
    out[#out+1] = ' / <a href="' .. base .. '">' .. esc(mount) .. '</a>'
    for part in rel:gmatch("[^/]+") do
      acc = acc .. part .. "/"
      out[#out+1] = ' / <a href="' .. base .. urlenc(acc) .. '">' .. esc(part) .. '</a>'
    end
  end
  out[#out+1] = '</p>\n<ul class="dir">\n'
  d.entries = d.entries or {}
  for _, e in ipairs(d.entries) do
    local href = base .. urlenc((rel ~= "" and (rel .. "/") or "") .. f(e, "name"))
    local dir  = f(e, "kind") == "dir"
    out[#out+1] = '<li class="' .. f(e, "kind") .. '"><a href="' .. esc(href) .. '">'
      .. esc(f(e, "name")) .. (dir and "/" or "") .. '</a>'
    if not dir then out[#out+1] = ' <span class="stage">' .. human(e.size) .. '</span>' end
    out[#out+1] = '</li>\n'
  end
  if #d.entries == 0 then out[#out+1] = '<li><em>empty</em></li>\n' end
  out[#out+1] = '</ul>\n'
  return page(mount, table.concat(out))
end

function render.mounts(d)
  local out = { '<h1>mounts</h1>\n' }
  out[#out+1] = '<p>Folders from elsewhere on disk, exposed here by symlink. '
    .. 'The only paths allowed to leave <code>site/</code>.</p>\n<ul class="dir">\n'
  d.entries = d.entries or {}
  for _, e in ipairs(d.entries) do
    out[#out+1] = '<li class="dir"><a href="/mnt/' .. esc(f(e, "name")) .. '/">'
      .. esc(f(e, "name")) .. '/</a></li>\n'
  end
  if #d.entries == 0 then
    out[#out+1] = '<li><em>none. <code>ln -s /some/dir site/mnt/name</code></em></li>\n'
  end
  out[#out+1] = '</ul>\n'
  return page("mounts", table.concat(out))
end

function render.notfound(d)
  return page("nothing grows here",
    '<h1>nothing grows here</h1>\n<p class="stage">' .. esc(f(d, "path")) .. '</p>\n')
end
