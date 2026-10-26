import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ShipStatus } from '@shared/types'
import { stripHidden } from '@shared/text'
import { linkInPath } from './pathScope'

/**
 * Getting a game ready to publish and earn: a ship checklist the Lead works through (the "Ship v1" milestone), and
 * purchase templates (game passes and developer products) the agents build on. New games get them when they're
 * created; an existing game gets them from its Overview.
 */

export const CHECKLIST = 'design-vault/Ship Checklist.md'
export const PRODUCTS = 'src/shared/Products.luau'

export const SHIP_CHECKLIST = `---
tags: [design, ship]
---
# Ship checklist

The smallest version worth publishing: fun for ten minutes, with a goal and two or three things to buy. This is milestone 1 ("Ship v1"); depth comes after launch. The Lead ticks items as they're done. Items marked (you) need the product owner. Hangar shows the progress on the game's Overview.

## Game
- [ ] The core loop works from start to finish: what a new player does in their first five minutes
- [ ] A goal players can see: a way to win a round, finish, or progress
- [ ] Controls work on phone and tablet (touch) as well as PC
- [ ] Two players at once in Studio (Test → Clients and Servers, 2 players) with no errors
- [ ] A 10-minute play with no errors in the Output window

## Purchases
- [ ] Two or three things to buy, listed in \`src/shared/Products.luau\`: cosmetics, convenience or a VIP perk. Nothing that makes paying players stronger in a fair fight
- [ ] Each one is granted in code (\`Monetization.onPass\` / \`Monetization.onProduct\` in \`src/server/Monetization.luau\`), and a Shop button opens it (\`src/client/Shop.luau\`)
- [ ] (you) Each one created in the Creator Hub (your game → Monetization → Passes / Developer Products) and its ID pasted into \`Products.luau\`
- [ ] Each one bought in a Studio test and granted correctly (Studio test purchases are free; turn on Game Settings → Security → "Enable Studio Access to API Services" first)

## Store page (you)
- [ ] Name, description and genre set in the Creator Hub
- [ ] An icon (512×512) and at least one thumbnail
- [ ] The maturity questionnaire answered
- [ ] The experience set to public

## Launch
- [ ] (you) Published to the live game from Hangar (the game's Overview → Publish to live game)
`

export const PRODUCTS_LUAU = `--!strict
-- Everything players can buy with Robux.
-- Game passes are bought once and kept for good; developer products can be bought again and again.
-- Create each one in the Creator Hub (your game → Monetization), then paste its ID below. An ID of 0 means it
-- hasn't been created yet: it can't be bought, and Hangar's ship checklist counts it as missing.
--
-- Examples (the key on the left is what code uses: Monetization.onPass("VIP", ...), Shop.buyPass("VIP")):
--   VIP = { id = 0, name = "VIP", price = 199, description = "A gold name tag and 2x daily reward." },
--   Coins100 = { id = 0, name = "100 Coins", price = 49, description = "100 coins to spend in the shop." },

export type Item = { id: number, name: string, price: number, description: string }

return {
	Passes = {} :: { [string]: Item },
	Products = {} :: { [string]: Item },
}
`

export const MONETIZATION_LUAU = `--!strict
-- Robux purchases, on the server. Game code says what each purchase gives:
--   Monetization.onPass("VIP", function(player) ... end)            -- runs when an owner joins, and right after buying
--   Monetization.onProduct("Coins100", function(player) ... return true end)  -- return true once it's given
-- A product's receipt is recorded, so a purchase Roblox retries is never given twice.
local DataStoreService = game:GetService("DataStoreService")
local MarketplaceService = game:GetService("MarketplaceService")
local Players = game:GetService("Players")
local Products = require(game:GetService("ReplicatedStorage").Shared.Products)

local Monetization = {}

type PassHandler = (player: Player) -> ()
type ProductHandler = (player: Player) -> boolean

local passHandlers: { [string]: PassHandler } = {}
local productHandlers: { [string]: ProductHandler } = {}
local owned: { [Player]: { [string]: boolean } } = {}
local history = DataStoreService:GetDataStore("PurchaseHistory")

local function keyFor(list: { [string]: Products.Item }, id: number): string?
	if id == 0 then
		return nil
	end
	for key, item in list do
		if item.id == id then
			return key
		end
	end
	return nil
end

function Monetization.ownsPass(player: Player, key: string): boolean
	local cache = owned[player]
	if cache and cache[key] ~= nil then
		return cache[key]
	end
	local pass = Products.Passes[key]
	if not pass or pass.id == 0 then
		return false
	end
	local ok, has = pcall(function()
		return MarketplaceService:UserOwnsGamePassAsync(player.UserId, pass.id)
	end)
	if not ok then
		return false
	end
	local entry = owned[player] or {}
	owned[player] = entry
	entry[key] = has == true
	return has == true
end

function Monetization.onPass(key: string, handler: PassHandler)
	passHandlers[key] = handler
	for _, player in Players:GetPlayers() do
		if Monetization.ownsPass(player, key) then
			task.spawn(handler, player)
		end
	end
end

function Monetization.onProduct(key: string, handler: ProductHandler)
	productHandlers[key] = handler
end

Players.PlayerAdded:Connect(function(player)
	for key, handler in passHandlers do
		if Monetization.ownsPass(player, key) then
			task.spawn(handler, player)
		end
	end
end)

Players.PlayerRemoving:Connect(function(player)
	owned[player] = nil
end)

MarketplaceService.PromptGamePassPurchaseFinished:Connect(function(player, passId, purchased)
	if not purchased then
		return
	end
	local key = keyFor(Products.Passes, passId)
	if not key then
		return
	end
	local entry = owned[player] or {}
	owned[player] = entry
	entry[key] = true
	local handler = passHandlers[key]
	if handler then
		task.spawn(handler, player)
	end
end)

MarketplaceService.ProcessReceipt = function(receipt)
	local key = keyFor(Products.Products, receipt.ProductId)
	local handler = if key then productHandlers[key] else nil
	local player = Players:GetPlayerByUserId(receipt.PlayerId)
	if not handler or not player then
		return Enum.ProductPurchaseDecision.NotProcessedYet
	end
	local grant: ProductHandler = handler
	local buyer: Player = player
	local granted = false
	local ok, err = pcall(function()
		history:UpdateAsync(\`{receipt.PlayerId}_{receipt.PurchaseId}\`, function(done)
			if done then
				granted = true
				return nil
			end
			if grant(buyer) then
				granted = true
				return true
			end
			return nil
		end)
	end)
	if not ok then
		warn(\`[Monetization] couldn't record purchase {receipt.PurchaseId}: {err}\`)
		return Enum.ProductPurchaseDecision.NotProcessedYet
	end
	if granted then
		return Enum.ProductPurchaseDecision.PurchaseGranted
	end
	return Enum.ProductPurchaseDecision.NotProcessedYet
end

return Monetization
`

export const SHOP_LUAU = `--!strict
-- Opens Roblox's purchase prompt for something listed in Shared.Products. Granting happens on the server
-- (src/server/Monetization.luau), never here.
local MarketplaceService = game:GetService("MarketplaceService")
local Players = game:GetService("Players")
local Products = require(game:GetService("ReplicatedStorage").Shared.Products)

local Shop = {}

function Shop.buyPass(key: string)
	local pass = Products.Passes[key]
	if not pass or pass.id == 0 then
		warn(\`[Shop] the pass "{key}" has no ID yet: create it in the Creator Hub, then paste it into Products\`)
		return
	end
	MarketplaceService:PromptGamePassPurchase(Players.LocalPlayer, pass.id)
end

function Shop.buyProduct(key: string)
	local product = Products.Products[key]
	if not product or product.id == 0 then
		warn(\`[Shop] the product "{key}" has no ID yet: create it in the Creator Hub, then paste it into Products\`)
		return
	end
	MarketplaceService:PromptProductPurchase(Players.LocalPlayer, product.id)
end

return Shop
`

/** The ship kit's files, by path in the game. */
export function shipKitFiles(): Record<string, string> {
  return {
    [CHECKLIST]: SHIP_CHECKLIST,
    [PRODUCTS]: PRODUCTS_LUAU,
    'src/server/Monetization.luau': MONETIZATION_LUAU,
    'src/client/Shop.luau': SHOP_LUAU
  }
}

/**
 * Write the kit's files that aren't there yet (never overwriting one), refusing to write through a link. Returns
 * the paths it wrote.
 */
export function writeShipKit(root: string): string[] {
  const written: string[] = []
  for (const [rel, body] of Object.entries(shipKitFiles())) {
    const file = join(root, rel)
    if (linkInPath(root, file) !== null) throw new Error(`${rel} goes through a link, so Hangar won't write it.`)
    if (existsSync(file)) continue
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, body, { encoding: 'utf8', flag: 'wx' })
    written.push(rel)
  }
  return written
}

const readSmall = (root: string, rel: string): string | null => {
  const file = join(root, rel)
  try {
    if (linkInPath(root, file) !== null || !lstatSync(file).isFile()) return null
    return stripHidden(readFileSync(file, 'utf8').slice(0, 200_000))
  } catch {
    return null
  }
}

/** How close a game is to shipping: its checklist (from the vault) and its purchases (from Products.luau). */
export function shipStatus(root: string): ShipStatus {
  const checklist = readSmall(root, CHECKLIST)
  const items: ShipStatus['items'] = []
  let section = ''
  for (const line of (checklist ?? '').split('\n')) {
    const h = /^##\s+(.+)$/.exec(line)
    if (h) {
      section = h[1]!.trim().slice(0, 60)
      continue
    }
    const m = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line)
    if (m) {
      const text = m[2]!.replace(/`/g, '').trim()
      items.push({ section, text: text.slice(0, 240), done: m[1] !== ' ', you: /^\(you\)/i.test(text) })
    }
  }
  const products = readSmall(root, PRODUCTS)
  const listed = [...(products ?? '').replace(/^\s*--.*$/gm, '').matchAll(/(\w+)\s*=\s*\{\s*id\s*=\s*(\d+)/g)].map((m) => ({ key: m[1]!, created: m[2] !== '0' }))
  return {
    hasChecklist: checklist !== null,
    hasPurchaseCode: products !== null && existsSync(join(root, 'src/server/Monetization.luau')),
    items,
    purchases: { listed: listed.length, created: listed.filter((p) => p.created).length }
  }
}
