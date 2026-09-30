/**
 * BioLabs Research CRM (blitz-api) — password and session helpers. Phase 2, 2026-09-05.
 * Used by server_v14.cjs. Pure Node (node:crypto only), no dependencies, testable on its own.
 *
 *   hashPassword(pw)            → "scrypt$N$r$p$<salt b64>$<hash b64>" for the passwordScrypt field
 *   verifyScrypt(pw, stored)    → boolean (constant-time compare)
 *   verifySha256(pw, hex)       → boolean, legacy passwordHash (unsalted SHA-256 hex from the pre-phase-2 client)
 *   sha256HexEqual(hexA, hexB)  → boolean, legacy client format {email, passwordHash}
 *   verifyPassword(pw, user)    → scrypt when the user has passwordScrypt, else the legacy hash, else false
 *   needsMigration(user)        → true when the user still has only the legacy hash
 *   generatePassword()          → "river-copper-signal-42": 4 dictionary words + a number, ≥ 22 chars
 *   createLoginThrottle()       → per-e-mail failure counter: 10 failures / 15 min → locked 15 min
 *   sessionExpired(s, now)      → idle > 12 h or age > 7 d
 *   publicUser(u)               → the user record without password fields (API answers, WebSocket broadcasts)
 */
'use strict';
const crypto = require('node:crypto');

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64, saltBytes: 16 };
// scrypt needs 128 * N * r bytes; Node's default maxmem (32 MiB) is just below that for N = 2^15, r = 8.
const scryptMaxmem = (N, r) => 256 * N * r;
const PASSWORD_MIN_LENGTH = 10;
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;

function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) throw new Error('hashPassword: password must be a non-empty string');
  const salt = crypto.randomBytes(SCRYPT.saltBytes);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: scryptMaxmem(SCRYPT.N, SCRYPT.r) });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

function verifyScrypt(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N < 2 || (N & (N - 1)) !== 0 || r < 1 || p < 1 || N > 2 ** 20) return false;
  const salt = Buffer.from(parts[4], 'base64'), expected = Buffer.from(parts[5], 'base64');
  if (salt.length < 8 || expected.length < 16) return false;
  let actual;
  try { actual = crypto.scryptSync(password, salt, expected.length, { N, r, p, maxmem: scryptMaxmem(N, r) }); } catch (e) { return false; }
  return crypto.timingSafeEqual(actual, expected);
}

function sha256HexEqual(hexA, hexB) {
  if (typeof hexA !== 'string' || typeof hexB !== 'string') return false;
  if (!/^[0-9a-fA-F]{64}$/.test(hexA) || !/^[0-9a-fA-F]{64}$/.test(hexB)) return false;
  return crypto.timingSafeEqual(Buffer.from(hexA, 'hex'), Buffer.from(hexB, 'hex'));
}

function verifySha256(password, storedHex) {
  if (typeof password !== 'string') return false;
  return sha256HexEqual(crypto.createHash('sha256').update(password, 'utf8').digest('hex'), storedHex);
}

function verifyPassword(password, user) {
  if (!user || typeof password !== 'string') return false;
  if (typeof user.passwordScrypt === 'string') return verifyScrypt(password, user.passwordScrypt);
  if (typeof user.passwordHash === 'string') return verifySha256(password, user.passwordHash);
  return false;
}

function needsMigration(user) {
  return !!user && typeof user.passwordScrypt !== 'string' && typeof user.passwordHash === 'string';
}

// Same cost as a real check, for e-mails that do not exist (keeps the timing of "unknown user" and "wrong password" alike).
const DUMMY_SCRYPT = hashPassword('timing-only-dummy-' + crypto.randomBytes(8).toString('hex'));

// 4–6 letter words from the EFF large wordlist (public, chosen for memorability): 2766 words.
const WORDS = 'abacus abide ablaze able abroad absurd accent aching acid acorn acre acting action active acts afar affair affirm affix afford aflame afloat afoot afraid aged agency agenda agent aghast agile aging agony agreed ahead ahoy aide aids ajar alarm album alias alibi aliens alike alive almost aloe aloft aloha alone aloof alto alumni always amaze amber ambush amends amid amigo amino amiss among amount ample amply amuck amulet amused amuser anchor anemia anemic anew anger angled angler angles animal anime ankle annex anthem antics antler antsy anvil anyhow anyone anyway aorta apache appear apple apply april apron aptly aqua area arena argue arise armed armful arming armory army aroma arose around array arrest arrive arson ascend ascent ashen ashes ashy aside askew asleep aspect aspire astute atlas atom atop atrium attach attain attest attic attire audio august author autism avatar avenge avenue avert avid avoid await awaken award aware awhile awning awoke awry axis babble babied baboon backed backer backup bacon badass badge badly baffle bagel bagful bagged baggie baggy baked bakery baking balmy bamboo banana banish banjo banked banker banner banter barbed barber barge barley barman barn barrel bash basics basil basin basis basket batboy batch bath baton bats battle bauble blade blah blame blank blast blazer bleach bleak bleep blend bless blimp bling blinks blip blitz blob blog blot blouse bluff bluish blunt blurb blurry blurt blush boat bobbed bobble bobcat body bogged boggle bogus boil bolt bonded boned boney bonnet bonsai bonus bony book booted booth bootie boots boozy borax boring boss botany botch both bottle bottom bounce bouncy bovine boxcar boxer boxing boxy breach breath breeze breezy briar bribe brick bride bright brim bring brink broken broker bronco bronze brook broom browse brunch brunt brush brute bubble bubbly bucked bucket buckle buddy budget buffed buffer buggy bulb bulge bulgur bulk bully bunch bundle bungee bunion bunny bunt busboy bush busily bust buzz cabana cabbie cable cache cackle cacti cactus caddie caddy cadet cage cake calm cameo camera camper campus canal canary cancel candle candy cane canine canned cannon cannot canola canon canopy canyon cape capped carat carbon carded caress cargo caring carol carrot carry cartel carton carve case cash casing casino casket catchy catnap catnip catsup cattle catty caucus causal cause caviar cavity cedar celery celtic cement census chafe chain chair chance change chant chaos chaps charm chase chaste chatty cheek cheer cheese cheesy chef chemo cherub chess chest chevy chewer chewy chief chili chill chimp chip chirpy chive choice chomp choosy chop chosen chrome chubby chuck chug chummy chump chunk churn chute cider cinch cinema circle circus citric citrus city civic civil clad claim clammy clamor clamp clang clash clasp class clause claw clay clean clear cleat cleft clench clerk clever client cling clinic clip clique cloak clock clone cloud clover clump clumsy clunky clutch coach coat cobalt cobweb cocoa coerce coffee coil coke cola cold collar collie colony colt coma come comfy comic coming comma common compel comply conch concur cone cope copied copier coping copper copy coral cork cornea corned corner corny corral corset cortex cosmic cosmos cost cotton couch cough could county cover cozily cozy cradle crafty cramp crane crank crate crave crayon crazed crazy crease create credit creed creme creole crepe crept crib cried crier crimp cringe crispy croak crock crook croon crop cross crouch crowd crown crumb crummy crust crux crying cube cuddle cuddly cupid cupped curdle cure curfew curing curled curler curly curry curse cursor curtly curtsy curve curvy cushy cusp cussed cycle cyclic cymbal dagger daily dainty dairy daisy dance dander dandy danger dangle dares darn dart dash data dating dawn daybed deacon dealer dealt dean debate debit debtor debug debunk decade decaf decal decay deceit decent deck decode decoy decree deduce deduct deed deem deepen deeply deface defame defeat defile define defog deftly defuse defy degree deity delay delete delta deluge deluxe demise demote denial denim denote dense dental deny depict deploy deport depose depth deputy derail derby detail detest deuce device dial diaper diary dice dicing dill dilute dime dimly dimmed dimmer dimple diner dinghy dingo dingy dining dinner dipped dipper disarm dish disk dismay disown ditch ditto ditzy diving dizzy doable docile dock dodge dodgy doily doing dole dollar dollop dolly domain donor donut doodle doozy dork dorsal dosage dose dotted douche dove down dowry doze drab drank draw dreamt dreamy dreary drench dress drew dried drier drift drippy driven driver drone drool droop drove drown drudge drum dubbed ducky duct dude duffel dugout duke duller duly dupe duplex duress during dusk dust duty duvet dwarf dweeb each eagle earful early earthy earwig easel easily easing easter eaten eatery eating eats ebay ebony ebook ecard echo eclair edge edging edgy editor effort egging eggnog either eject elated elbow eldest eleven elite elixir elope elude elves email embark ember emblem embody emboss emcee emit emote empty enable enamel encode encore ended ending energy engine engulf enrage enrich enroll ensure entail entire entity entomb entrap entree envoy envy enzyme epic equal equate equity erased eraser errand errant error erupt eskimo essay estate ether ethics evade even evict evil evoke evolve exact excess excuse exert exes exhale exhume exile exit exodus expand expel expend expert expire expose extent extras fable fabric facial facing factor fade fading falcon fall false fame family famine fancy fang faster faucet feast fedora feeble feed feel feisty feline femur fence fender ferret ferris ferry fervor fester fetal fetch fever fiber fiddle fifth fifty figure filing filled filler film filter filth finale finch finer finite five flail flaky flame flap flashy flask flatly fled fleshy flick flier flight flinch fling flint flip flirt float flock flop floral floss flyer flying foam foil folic folk follow fondly fondue font food fool footer fossil foster foyer frail frame frayed frays freely french frenzy fresh friday fridge fried friend frill fringe frisk frolic from front frosty froth frown frozen fruit frying gaffe gains gala galley gallon galore game gaming gamma gander gangly garage garden gargle garlic garnet garter gating gauze gave gawk gazing gear gecko geek geiger gender genre gently gents gerbil getup giant giblet giddy gift giggle giggly gigolo gilled gills girdle given giver giving gizmo glade gladly glance glare glass glider glitch glitzy gloomy glory gloss glove glue gluten gnarly gnat goal goes going golf gonad gone gong good gooey goofy google goon gopher gore gorged gory gossip gothic gotten gout gown grab graded grader grain granny grant grape graph grasp grass gravel graves gravy gray greedy green grew grid grief grill grime grimy grinch grip grit groggy groin groom groove groovy grope ground grout grove grower growl grub grudge grunge grunt guide guise gulf gully gulp gummy gurgle guru gush gusto gusty guts gutter hacked hacker haiku half halt halved halves hamlet hamper handed hangup hankie hanky happy harbor hardly hardy harsh hash hassle haste hasty hatbox hate hatred haunt haven hazard hazily hazing hazy headed header heap heat heave hedge hefty helium helmet helper hence henna herald herbal herbs hermit hertz hubcap huddle huff hula hulk hull human humble humbly humid hummus humped humvee hunger hungry hunk hunter hurdle hurled hurler hurray hurry hurt hush husked hybrid hyphen icing icky icon idiocy idiom idly igloo ignore iguana image impale impart impish imply impose impure iodine iodize ipad iphone ipod irate iron issue item itunes ivory jackal jacket jailer jargon jaunt java jawed jaws jazz jeep jelly jersey jester jiffy jigsaw jimmy jingle jinx jockey jogger john jolly jolt jovial joyous judge judo juggle juice juicy july jumble jumbo jump june junior junkie jurist juror jury justly kabob karate karma kebab keenly keep kelp kennel kept kettle kick kiln kilt kimono kindle kindly king kisser kite kitten kitty kiwi knee knelt knoll koala kooky kosher kudos kung ladder ladies ladle lagged lagoon lair lake lance landed lanky lapdog lapel lapped laptop lard large lark lash lasso last latch late lather latter launch laurel lavish lazily lazy left legacy legal legend legged lego legume lemon lend length lens lent lesser letter level levers liable life lifter likely liking lilac lilly lily limb limes limit line lingo lining linked lint lion liquid lisp list litmus litter little lived lively liver living lizard lucid lugged lumber lunacy lunar lung lurch lure lurk lushly luster lusty luxury lying lyrics macaw mace maggot magma maimed maker making malt mama mammal manger mangle mango mangy manila manly manned manor mantis mantra manual many march mardi margin marina marine marlin maroon marrow marry marshy mascot mashed masses math mating matrix matron matted matter mauve maybe mayday moaner mobile mocha mocker mockup modify module molar mold monday moody mooing mooned morale morse mosaic mossy most motion motive motor motto mouse mousy mouth move movie moving mower mowing much muck mulch mule mulled mumble mumbo mummy mumps muppet mural murky museum mushy music musket musky muster musty mutate mute mutiny mutt mutual muzzle myself myth nacho nail name naming nanny nape napkin napped nappy narrow native nature navy nearby nearly neatly nebula nectar negate neon nephew nerd nervy nest neuron neuter never next nibble niece nifty nimble nimbly ninja ninth nuclei nugget number numbly nutmeg nutty nuzzle nylon oasis object oblong oboe obtain obtuse occupy ocean ocelot octane ogle oink okay olive omega omen omit onion online only onset onto onward onyx oops ooze oozy opal open opium oppose other otter ouch ought ounce outage outbid outer outfit outing outlet output outwit oval ovary oven oxford oxygen oyster ozone paced pacify padded paddle pagan pager paging palace palm paltry panama panda pang panic pantry pants papaya paper parade parcel pardon parish parka parlor parole parrot parted partly party pasta pasted pastel pastor pasty patchy path patio patrol pauper paver paving pawing payday payee payer paying pebble pebbly pecan pectin pellet pelt pelvis pencil penny penpal perch perish perky perm pesky peso pester petal petite petri petted petty phobia phoney phony photo phrase plank plant plasma plated player plaza pleat pledge plenty plod plop plot plow ploy pluck plug plural plus poach poem poet pogo pointy poise poison poker poking polar police policy polio polish polka polo poncho pond pony pope poplar popper poppy pork porous portal portly poser posh posing possum postal posted poster pouch pounce pound pout power powwow prance prayer precut prefix prelaw prepay preppy preset press pretty prewar pried primal primer primp print prior prism prison prissy prize probe prone prong pronto proofs props proton proud proved proven proxy prozac prude prune public pucker pueblo pull pulp pulse puma pumice pummel punch punk pupil puppet puppy purely purge purify purist purity purple purr purse pusher pushup pushy putt puzzle python quack quail quake qualm quarry quench query quiet quill quilt quirk quit quiver quote rabid race racing racism rack racoon radar radial radio radish raffle raft rage ragged raging raider raisin rake raking rally ramble ramp ramrod ranch random ranged ranger ranked rants rare rarity rascal rash ravage raven ravine raving reach ream reason rebate rebel reboot reborn rebuff recall recant recast recede recent recess recite recoil recopy record recoup rectal refill reflex reflux refold refund refuse refute regain reggae regime region rehab reheat rehire rejoin relax relay relic relish relive reload relock rely remake remark remedy remix remold remote rename rental rented renter reopen repair repave repeal repent replay reply repose repost reps rerun resale reseal resend resent reset resize resort result resume retail retake retold retool retry return retype reuse reveal reverb revert revise revoke revolt reward rewash rewind rewire reword rework rewrap rhyme ribbon rice riches richly ridden ride riding rift rigid rigor rimmed rind rink rinse riot ripple rise rising risk ritzy rival roamer roast robe robin robust rocker rocket rocky rogue roman romp rope roping roster rosy rotten rover roving royal rubbed rubber rubble ruby ruckus rudder ruined rule rumble rumor runner runny runt runway rural ruse rush rust sacred sadden sadly safari safely saga sage saggy said saint sake salad salami salary saline salon saloon salsa salt salute same sample sandal sanded sandy sank santa sappy sash sassy satin saucy sauna savage saved savior savor scabby scale scam scant scarce scared scarf scary scenic scheme scion scoff scone scoop scope scorch scored scorer scorn scotch scouts scrap screen scribe script scroll scuba scuff scurvy second secret sector sedan sedate seduce seldom self senate send senior sepia septic septum sequel series sermon serve sesame settle setup shabby shack shaded shadow shady shaft shaky shale shame shank shanty shape share shawl sheath shed sheep sheet shelf shell shelve sherry shield shifty shimmy shine shiny ship shirt shock shone shore shorts shorty shout shove shower shown showy shrank shriek shrill shrimp shrine shrink shrubs shrug shrunk shun shush shut siding sierra siesta sift silent silica silk silly silo silt silver simile simple simply singer single sinner siren sister sitcom sitter sixth size sizing sizzle skater sketch skewed skewer skid skied skier skies skiing skinny skirt skype slab slacks slain slam slang slate slaw sled sleek sleep sleet sleeve slept sliced slicer slick slider slimy slinky slip slit sliver slogan sloped sloppy slot sludge slug slum slurp slush small smell smile smirk smite smith smock smog smoked smoky smooth smudge smudgy smugly snack snap snare snarl snazzy sneak sneer sneeze snide sniff snitch snooze snore snort snout snowy snub snuff snugly speak specks speech speed spent spew sphere sphinx spider spied spiffy spill spilt spinal spiny spiral spleen splice spoils spoken sponge spongy spoof spooky spool spoon spore sports sporty spotty spouse spout sprain sprang sprawl spray spree sprig spring sprint sprite sprout spruce sprung spry spud spur squad squall squash squeak squid squint squire squirt stable stack staff stage stamp stand stank staple starch stark starry stash state static statue status stays steam steed steep stem stench step stereo stew stick stifle stilt stingy stinky stir stitch stock stoic stoke stole stomp stony stood stooge stool stoop storm stout stove straw stray streak stream street strep stress strewn strict stride strife strike strive strobe strode struck strum strung strut stucco stuck studio study stuffy stump stung stunt stupor sturdy stylus suave sublet subpar subtly suburb subway such sudden sudoku suds suffix sugar suing suitor sulfur sulk sullen sultry supper supply surely surfer survey sushi swab swan swarm sway swear sweat sweep swell swept swerve swipe swirl switch swivel swoop swoosh swore sworn swung syrup system tabby tables tablet tackle tacky taco take taking talcum tall talon tamale tamer tamper tank tanned taps target tarmac tarot tartar tartly task tassel taste tasty tattle tattoo taunt tavern thank that thaw thee theft theme these thesis thigh thing think thinly thirty thong thorn those thrash thread thrift thrill thrive throat throng thud thumb thus tiara tibia tidal tidbit tidy tiger tile tiling till tilt timid timing tingle tingly tinker tinsel tint tiny tipoff tipped tipper tiptop tiring tissue trace track trade train trance traps trash travel tray treat treble tree tremor trench trend triage trial tricky tried trifle trio tripod trophy trough trout trowel truce truck trump trunks truth tubby tulip tumble tummy turban turf turkey turret turtle tusk tutor tutu tweak tweed tweet twelve twenty twerp twice twig twine twins twirl twisty twitch tycoon tying tyke udder ultra umpire unable unbend unbent unclad uncle unclip unclog uncork uncut undead undone unease uneasy uneven unfair unfold unglue unholy unhook unify union unison unit unkind unless unlit unmade unpack unpaid unplug unread unreal unrest unripe unroll unruly unsafe unsaid unseen unsent unsnap unsold unsure untidy untie until untold untrue unused unwary unwed unwell unwind unworn unzip upbeat update upheld uphill uphold upload upon upper uproar uproot upside uptake uptown upward upwind urban urchin urgent urging usable usage used user usher usual utmost utopia utter vacant vacate valid valium valley value vanish vanity varied vastly veal vegan veggie velcro velvet vendor venue venus verify verse versus very vessel vest veto viable vibes vice video viewer violet violin viper viral virus visa vision visor vista vixen voice void volley voter voting vowed vowel voyage wafer waffle waged wager wages waggle wagon wake waking walk walnut walrus waltz wand wanted wasabi washed washer wasp watch water waving wavy whacky wham wharf wheat whiff whinny whiny whole whoops wick widely widen widget widow width wife wifi wilder wildly willed willow wilt wimp wince wind wing winner winter wipe wired wiring wiry wisdom wise wish wispy wizard wobble wobbly wolf womb woof wooing wool woozy word work worry worst wound woven wrath wreath wrench wrist xbox xerox yahoo yard yarn yeah yearly yeast yelp yield yippee yodel yoga yogurt yonder yoyo yummy zebra zero zesty zippy zips zodiac zombie zone zoning zoom'.split(' ');

function generatePassword(wordCount = 4) {
  const parts = [];
  for (let i = 0; i < wordCount; i++) parts.push(WORDS[crypto.randomInt(WORDS.length)]);
  parts.push(String(crypto.randomInt(10, 100)));
  return parts.join('-');
}

function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Per-e-mail login throttle (idea from crm-app backend/utils/login-throttle.cjs). In memory: one pm2 process, resets on
// restart. Never bans an IP — that stays with the per-IP counter in server_v14.cjs. The lock is short (15 min) and is not
// extended by attempts made while it is active; a determined attacker can re-trigger it after expiry (10 requests per
// 15 min) — that keeps one account out for a while but never hands out the password, which is the trade-off chosen here.
function createLoginThrottle(options = {}) {
  const maxFailures = options.maxFailures || 10;
  const windowMs = options.windowMs || 15 * 60 * 1000;
  const lockMs = options.lockMs || 15 * 60 * 1000;
  const entries = new Map(); // email → { ts: number[], lockedUntil: number }
  const prune = (entry, now) => { entry.ts = entry.ts.filter(t => t > now - windowMs); };
  const lockedAnswer = (entry, now, justLocked) => ({
    locked: true, justLocked, failures: entry.ts.length,
    retryAfterSec: Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000)),
    retryAfterMin: Math.max(1, Math.ceil((entry.lockedUntil - now) / 60000)),
  });
  function check(email, now = Date.now()) {
    const entry = entries.get(normalizeEmail(email));
    if (!entry) return { locked: false, failures: 0, retryAfterSec: 0, retryAfterMin: 0 };
    if (entry.lockedUntil > now) return lockedAnswer(entry, now, false);
    prune(entry, now);
    return { locked: false, failures: entry.ts.length, retryAfterSec: 0, retryAfterMin: 0 };
  }
  function recordFailure(email, now = Date.now()) {
    const key = normalizeEmail(email);
    if (!key) return { locked: false, justLocked: false, failures: 0, retryAfterSec: 0, retryAfterMin: 0 };
    let entry = entries.get(key);
    if (!entry) { entry = { ts: [], lockedUntil: 0 }; entries.set(key, entry); }
    if (entry.lockedUntil > now) return lockedAnswer(entry, now, false);
    prune(entry, now);
    entry.ts.push(now);
    if (entry.ts.length >= maxFailures) {
      entry.lockedUntil = now + lockMs;
      const failures = entry.ts.length;
      entry.ts = []; // fresh budget once the lock expires
      return Object.assign(lockedAnswer(entry, now, true), { failures });
    }
    return { locked: false, justLocked: false, failures: entry.ts.length, retryAfterSec: 0, retryAfterMin: 0 };
  }
  function clear(email) { return entries.delete(normalizeEmail(email)); }
  function sweep(now = Date.now()) {
    let removed = 0;
    for (const [key, entry] of entries) {
      if (entry.lockedUntil > now) continue;
      prune(entry, now);
      if (entry.ts.length === 0) { entries.delete(key); removed++; }
    }
    return removed;
  }
  return { check, recordFailure, clear, sweep, size: () => entries.size };
}

// A session is over after SESSION_IDLE_MS without a request or SESSION_MAX_MS after login, whichever comes first.
// Sessions written before phase 2 have no lastSeenAt: their createdAt counts as the last activity.
function sessionExpired(session, now = Date.now()) {
  if (!session || typeof session.createdAt !== 'number') return true;
  const lastSeen = typeof session.lastSeenAt === 'number' ? session.lastSeenAt : session.createdAt;
  return now - session.createdAt > SESSION_MAX_MS || now - lastSeen > SESSION_IDLE_MS;
}

function publicUser(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    email: u.email,
    name: u.name,
    role: u.role === 'admin' ? 'admin' : 'staff',
    pageAccess: Array.isArray(u.pageAccess) ? u.pageAccess : [],
    lastLogin: u.lastLogin || null,
    createdAt: u.createdAt || null,
    updatedAt: u.updatedAt || null,
  };
}

module.exports = {
  PASSWORD_MIN_LENGTH, SESSION_IDLE_MS, SESSION_MAX_MS, DUMMY_SCRYPT, WORDS,
  hashPassword, verifyScrypt, verifySha256, sha256HexEqual, verifyPassword, needsMigration,
  generatePassword, normalizeEmail, isValidEmail, createLoginThrottle, sessionExpired, publicUser,
};
