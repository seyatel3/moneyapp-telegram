/* MoneyAPP Web — E2E crypto layer (v1.11.10).
 *
 * Everything is WebCrypto, no dependencies. Two layers:
 *   - master key  = 32 random bytes, generated once on first launch; it is
 *     what the data is encrypted with and what the 24-word phrase encodes
 *     (BIP39-style, 256-bit entropy + 8-bit checksum; official English
 *     wordlist canonical, plus an index-paired Russian display list —
 *     the phrase can be entered in either language). Changing the PIN does NOT change the master key, so the
 *     phrase stays valid forever; recovering from the phrase also leaves it
 *     unchanged.
 *   - PIN wrap    = master key encrypted with AES-GCM-256 under a key
 *     PBKDF2-SHA256(PIN, salt=SALT_CONST|uid, 2,100,000 iters) -> 32 B.
 *     Storing the master key under the PIN lets the user re-login with the
 *     PIN or change it without ever exposing the key.
 *   - data at rest = AES-GCM-256 under the master key (fresh 12 B IV per
 *     save), plaintext padded to 256 B blocks + random 1-4 B so the blob size
 *     does not reveal the exact plaintext length.
 *
 * Blob layout (see app.py /api/blob):
 *   { v:1, ivKey, ctKey, iv, ct }  — ctKey = AES-GCM(master key, PIN key),
 *   ct = AES-GCM(state JSON, master key). The PIN key is derived in the
 *   browser and never sent to the server, which stores only the blob and
 *   cannot read the data.
 *
 * Browser: window.MACrypto. Node (tests): require("crypto.js").
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MACrypto = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this),
function () {
  "use strict";

  const ITERATIONS = 2100000; // OWASP 2024 minimum for PBKDF2-SHA256
  const SALT = new TextEncoder().encode("moneyapp-tg-e2e-v1");
  const BLOCK = 256; // padding granularity, bytes
  const te = new TextEncoder();
  const td = new TextDecoder();

  /* ---------------------------------------------------------- base64 ---- */
  function b64u8(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }
  function u8b64(b64) {
    const s = atob(b64);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }

  /* ----------------------------------------------------- key derivation - */
  function uidBytes(uid) {
    const b = new Uint8Array(8);
    let v = BigInt(uid | 0);
    for (let i = 0; i < 8; i++) {
      b[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return b;
  }
  // salt = SALT || uid (LE 8 B). The uid part makes precomputed tables
  // per-user (an attacker cracking one blob cannot reuse the work).
  async function derivePinKey(pin, uid) {
    const salt = new Uint8Array(SALT.length + 8);
    salt.set(SALT, 0);
    salt.set(uidBytes(uid), SALT.length);
    const base = await crypto.subtle.importKey("raw", te.encode(String(pin)), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: salt, iterations: ITERATIONS, hash: "SHA-256" }, base, 256);
    return crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  async function keyFromBytes(bytes) {
    return crypto.subtle.importKey("raw", bytes, "AES-GCM", true, ["encrypt", "decrypt"]);
  }

  // Random 32 B master key (extractable: needed to derive the phrase and to
  // re-wrap on PIN change).
  async function genMasterKey() {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    return keyFromBytes(raw);
  }

  // master key -> {ivKey, ctKey} wrapped under PBKDF2(PIN)
  async function wrapMasterKey(masterKey, pin, uid) {
    const pinKey = await derivePinKey(pin, uid);
    const raw = await crypto.subtle.exportKey("raw", masterKey);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv }, pinKey, raw));
    return { ivKey: b64u8(iv), ctKey: b64u8(ct) };
  }

  // {ivKey, ctKey} + PIN -> master key (throws "wrong key" on bad PIN)
  async function unwrapMasterKey(wrap, pin, uid) {
    if (!wrap || typeof wrap.ivKey !== "string" || typeof wrap.ctKey !== "string") {
      throw new Error("bad wrap");
    }
    const iv = u8b64(wrap.ivKey), ct = u8b64(wrap.ctKey);
    if (iv.length !== 12 || ct.length !== 48) throw new Error("bad wrap");
    const pinKey = await derivePinKey(pin, uid);
    let raw;
    try {
      raw = new Uint8Array(await crypto.subtle.decrypt(
        { name: "AES-GCM", iv }, pinKey, ct));
    } catch (e) {
      throw new Error("wrong key");
    }
    return keyFromBytes(raw);
  }

  /* ------------------------------------------------- encrypt / decrypt -- */
  async function encryptData(data, key) {
    const plain = te.encode(JSON.stringify(data));
    const head = 4; // big-endian pad length
    let padLen = (BLOCK - ((head + plain.length) % BLOCK)) % BLOCK;
    padLen += 1 + Math.floor(Math.random() * 4); // 1..4 random extra bytes
    const buf = new Uint8Array(head + plain.length + padLen);
    buf[0] = (padLen >> 24) & 0xff;
    buf[1] = (padLen >> 16) & 0xff;
    buf[2] = (padLen >> 8) & 0xff;
    buf[3] = padLen & 0xff;
    buf.set(plain, head);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, buf));
    return { v: 1, iv: b64u8(iv), ct: b64u8(ct) };
  }

  async function decryptBlob(blob, key) {
    if (!blob || blob.v !== 1 || typeof blob.iv !== "string" || typeof blob.ct !== "string") {
      throw new Error("bad blob");
    }
    const iv = u8b64(blob.iv);
    const ct = u8b64(blob.ct);
    if (iv.length !== 12 || ct.length < 32) throw new Error("bad blob");
    let plain;
    try {
      plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
    } catch (e) {
      throw new Error("wrong key"); // bad PIN or bad phrase
    }
    const padLen = ((plain[0] << 24) | (plain[1] << 16) | (plain[2] << 8) | plain[3]) >>> 0;
    if (padLen < 1 || padLen > plain.length - 4) throw new Error("bad padding");
    const json = td.decode(plain.subarray(4, plain.length - padLen));
    return JSON.parse(json);
  }

  /* ------------------------------------------------- BIP39 phrase (RU->EN,
   * official wordlist, 24 words = 256-bit key + 8-bit checksum) ----------- */
  const WORDS = [
    "abandon","ability","able","about","above","absent","absorb","abstract","absurd","abuse",
    "access","accident","account","accuse","achieve","acid","acoustic","acquire","across","act",
    "action","actor","actress","actual","adapt","add","addict","address","adjust","admit",
    "adult","advance","advice","aerobic","affair","afford","afraid","again","age","agent",
    "agree","ahead","aim","air","airport","aisle","alarm","album","alcohol","alert",
    "alien","all","alley","allow","almost","alone","alpha","already","also","alter",
    "always","amateur","amazing","among","amount","amused","analyst","anchor","ancient","anger",
    "angle","angry","animal","ankle","announce","annual","another","answer","antenna","antique",
    "anxiety","any","apart","apology","appear","apple","approve","april","arch","arctic",
    "area","arena","argue","arm","armed","armor","army","around","arrange","arrest",
    "arrive","arrow","art","artefact","artist","artwork","ask","aspect","assault","asset",
    "assist","assume","asthma","athlete","atom","attack","attend","attitude","attract","auction",
    "audit","august","aunt","author","auto","autumn","average","avocado","avoid","awake",
    "aware","away","awesome","awful","awkward","axis","baby","bachelor","bacon","badge",
    "bag","balance","balcony","ball","bamboo","banana","banner","bar","barely","bargain",
    "barrel","base","basic","basket","battle","beach","bean","beauty","because","become",
    "beef","before","begin","behave","behind","believe","below","belt","bench","benefit",
    "best","betray","better","between","beyond","bicycle","bid","bike","bind","biology",
    "bird","birth","bitter","black","blade","blame","blanket","blast","bleak","bless",
    "blind","blood","blossom","blouse","blue","blur","blush","board","boat","body",
    "boil","bomb","bone","bonus","book","boost","border","boring","borrow","boss",
    "bottom","bounce","box","boy","bracket","brain","brand","brass","brave","bread",
    "breeze","brick","bridge","brief","bright","bring","brisk","broccoli","broken","bronze",
    "broom","brother","brown","brush","bubble","buddy","budget","buffalo","build","bulb",
    "bulk","bullet","bundle","bunker","burden","burger","burst","bus","business","busy",
    "butter","buyer","buzz","cabbage","cabin","cable","cactus","cage","cake","call",
    "calm","camera","camp","can","canal","cancel","candy","cannon","canoe","canvas",
    "canyon","capable","capital","captain","car","carbon","card","cargo","carpet","carry",
    "cart","case","cash","casino","castle","casual","cat","catalog","catch","category",
    "cattle","caught","cause","caution","cave","ceiling","celery","cement","census","century",
    "cereal","certain","chair","chalk","champion","change","chaos","chapter","charge","chase",
    "chat","cheap","check","cheese","chef","cherry","chest","chicken","chief","child",
    "chimney","choice","choose","chronic","chuckle","chunk","churn","cigar","cinnamon","circle",
    "citizen","city","civil","claim","clap","clarify","claw","clay","clean","clerk",
    "clever","click","client","cliff","climb","clinic","clip","clock","clog","close",
    "cloth","cloud","clown","club","clump","cluster","clutch","coach","coast","coconut",
    "code","coffee","coil","coin","collect","color","column","combine","come","comfort",
    "comic","common","company","concert","conduct","confirm","congress","connect","consider","control",
    "convince","cook","cool","copper","copy","coral","core","corn","correct","cost",
    "cotton","couch","country","couple","course","cousin","cover","coyote","crack","cradle",
    "craft","cram","crane","crash","crater","crawl","crazy","cream","credit","creek",
    "crew","cricket","crime","crisp","critic","crop","cross","crouch","crowd","crucial",
    "cruel","cruise","crumble","crunch","crush","cry","crystal","cube","culture","cup",
    "cupboard","curious","current","curtain","curve","cushion","custom","cute","cycle","dad",
    "damage","damp","dance","danger","daring","dash","daughter","dawn","day","deal",
    "debate","debris","decade","december","decide","decline","decorate","decrease","deer","defense",
    "define","defy","degree","delay","deliver","demand","demise","denial","dentist","deny",
    "depart","depend","deposit","depth","deputy","derive","describe","desert","design","desk",
    "despair","destroy","detail","detect","develop","device","devote","diagram","dial","diamond",
    "diary","dice","diesel","diet","differ","digital","dignity","dilemma","dinner","dinosaur",
    "direct","dirt","disagree","discover","disease","dish","dismiss","disorder","display","distance",
    "divert","divide","divorce","dizzy","doctor","document","dog","doll","dolphin","domain",
    "donate","donkey","donor","door","dose","double","dove","draft","dragon","drama",
    "drastic","draw","dream","dress","drift","drill","drink","drip","drive","drop",
    "drum","dry","duck","dumb","dune","during","dust","dutch","duty","dwarf",
    "dynamic","eager","eagle","early","earn","earth","easily","east","easy","echo",
    "ecology","economy","edge","edit","educate","effort","egg","eight","either","elbow",
    "elder","electric","elegant","element","elephant","elevator","elite","else","embark","embody",
    "embrace","emerge","emotion","employ","empower","empty","enable","enact","end","endless",
    "endorse","enemy","energy","enforce","engage","engine","enhance","enjoy","enlist","enough",
    "enrich","enroll","ensure","enter","entire","entry","envelope","episode","equal","equip",
    "era","erase","erode","erosion","error","erupt","escape","essay","essence","estate",
    "eternal","ethics","evidence","evil","evoke","evolve","exact","example","excess","exchange",
    "excite","exclude","excuse","execute","exercise","exhaust","exhibit","exile","exist","exit",
    "exotic","expand","expect","expire","explain","expose","express","extend","extra","eye",
    "eyebrow","fabric","face","faculty","fade","faint","faith","fall","false","fame",
    "family","famous","fan","fancy","fantasy","farm","fashion","fat","fatal","father",
    "fatigue","fault","favorite","feature","february","federal","fee","feed","feel","female",
    "fence","festival","fetch","fever","few","fiber","fiction","field","figure","file",
    "film","filter","final","find","fine","finger","finish","fire","firm","first",
    "fiscal","fish","fit","fitness","fix","flag","flame","flash","flat","flavor",
    "flee","flight","flip","float","flock","floor","flower","fluid","flush","fly",
    "foam","focus","fog","foil","fold","follow","food","foot","force","forest",
    "forget","fork","fortune","forum","forward","fossil","foster","found","fox","fragile",
    "frame","frequent","fresh","friend","fringe","frog","front","frost","frown","frozen",
    "fruit","fuel","fun","funny","furnace","fury","future","gadget","gain","galaxy",
    "gallery","game","gap","garage","garbage","garden","garlic","garment","gas","gasp",
    "gate","gather","gauge","gaze","general","genius","genre","gentle","genuine","gesture",
    "ghost","giant","gift","giggle","ginger","giraffe","girl","give","glad","glance",
    "glare","glass","glide","glimpse","globe","gloom","glory","glove","glow","glue",
    "goat","goddess","gold","good","goose","gorilla","gospel","gossip","govern","gown",
    "grab","grace","grain","grant","grape","grass","gravity","great","green","grid",
    "grief","grit","grocery","group","grow","grunt","guard","guess","guide","guilt",
    "guitar","gun","gym","habit","hair","half","hammer","hamster","hand","happy",
    "harbor","hard","harsh","harvest","hat","have","hawk","hazard","head","health",
    "heart","heavy","hedgehog","height","hello","helmet","help","hen","hero","hidden",
    "high","hill","hint","hip","hire","history","hobby","hockey","hold","hole",
    "holiday","hollow","home","honey","hood","hope","horn","horror","horse","hospital",
    "host","hotel","hour","hover","hub","huge","human","humble","humor","hundred",
    "hungry","hunt","hurdle","hurry","hurt","husband","hybrid","ice","icon","idea",
    "identify","idle","ignore","ill","illegal","illness","image","imitate","immense","immune",
    "impact","impose","improve","impulse","inch","include","income","increase","index","indicate",
    "indoor","industry","infant","inflict","inform","inhale","inherit","initial","inject","injury",
    "inmate","inner","innocent","input","inquiry","insane","insect","inside","inspire","install",
    "intact","interest","into","invest","invite","involve","iron","island","isolate","issue",
    "item","ivory","jacket","jaguar","jar","jazz","jealous","jeans","jelly","jewel",
    "job","join","joke","journey","joy","judge","juice","jump","jungle","junior",
    "junk","just","kangaroo","keen","keep","ketchup","key","kick","kid","kidney",
    "kind","kingdom","kiss","kit","kitchen","kite","kitten","kiwi","knee","knife",
    "knock","know","lab","label","labor","ladder","lady","lake","lamp","language",
    "laptop","large","later","latin","laugh","laundry","lava","law","lawn","lawsuit",
    "layer","lazy","leader","leaf","learn","leave","lecture","left","leg","legal",
    "legend","leisure","lemon","lend","length","lens","leopard","lesson","letter","level",
    "liar","liberty","library","license","life","lift","light","like","limb","limit",
    "link","lion","liquid","list","little","live","lizard","load","loan","lobster",
    "local","lock","logic","lonely","long","loop","lottery","loud","lounge","love",
    "loyal","lucky","luggage","lumber","lunar","lunch","luxury","lyrics","machine","mad",
    "magic","magnet","maid","mail","main","major","make","mammal","man","manage",
    "mandate","mango","mansion","manual","maple","marble","march","margin","marine","market",
    "marriage","mask","mass","master","match","material","math","matrix","matter","maximum",
    "maze","meadow","mean","measure","meat","mechanic","medal","media","melody","melt",
    "member","memory","mention","menu","mercy","merge","merit","merry","mesh","message",
    "metal","method","middle","midnight","milk","million","mimic","mind","minimum","minor",
    "minute","miracle","mirror","misery","miss","mistake","mix","mixed","mixture","mobile",
    "model","modify","mom","moment","monitor","monkey","monster","month","moon","moral",
    "more","morning","mosquito","mother","motion","motor","mountain","mouse","move","movie",
    "much","muffin","mule","multiply","muscle","museum","mushroom","music","must","mutual",
    "myself","mystery","myth","naive","name","napkin","narrow","nasty","nation","nature",
    "near","neck","need","negative","neglect","neither","nephew","nerve","nest","net",
    "network","neutral","never","news","next","nice","night","noble","noise","nominee",
    "noodle","normal","north","nose","notable","note","nothing","notice","novel","now",
    "nuclear","number","nurse","nut","oak","obey","object","oblige","obscure","observe",
    "obtain","obvious","occur","ocean","october","odor","off","offer","office","often",
    "oil","okay","old","olive","olympic","omit","once","one","onion","online",
    "only","open","opera","opinion","oppose","option","orange","orbit","orchard","order",
    "ordinary","organ","orient","original","orphan","ostrich","other","outdoor","outer","output",
    "outside","oval","oven","over","own","owner","oxygen","oyster","ozone","pact",
    "paddle","page","pair","palace","palm","panda","panel","panic","panther","paper",
    "parade","parent","park","parrot","party","pass","patch","path","patient","patrol",
    "pattern","pause","pave","payment","peace","peanut","pear","peasant","pelican","pen",
    "penalty","pencil","people","pepper","perfect","permit","person","pet","phone","photo",
    "phrase","physical","piano","picnic","picture","piece","pig","pigeon","pill","pilot",
    "pink","pioneer","pipe","pistol","pitch","pizza","place","planet","plastic","plate",
    "play","please","pledge","pluck","plug","plunge","poem","poet","point","polar",
    "pole","police","pond","pony","pool","popular","portion","position","possible","post",
    "potato","pottery","poverty","powder","power","practice","praise","predict","prefer","prepare",
    "present","pretty","prevent","price","pride","primary","print","priority","prison","private",
    "prize","problem","process","produce","profit","program","project","promote","proof","property",
    "prosper","protect","proud","provide","public","pudding","pull","pulp","pulse","pumpkin",
    "punch","pupil","puppy","purchase","purity","purpose","purse","push","put","puzzle",
    "pyramid","quality","quantum","quarter","question","quick","quit","quiz","quote","rabbit",
    "raccoon","race","rack","radar","radio","rail","rain","raise","rally","ramp",
    "ranch","random","range","rapid","rare","rate","rather","raven","raw","razor",
    "ready","real","reason","rebel","rebuild","recall","receive","recipe","record","recycle",
    "reduce","reflect","reform","refuse","region","regret","regular","reject","relax","release",
    "relief","rely","remain","remember","remind","remove","render","renew","rent","reopen",
    "repair","repeat","replace","report","require","rescue","resemble","resist","resource","response",
    "result","retire","retreat","return","reunion","reveal","review","reward","rhythm","rib",
    "ribbon","rice","rich","ride","ridge","rifle","right","rigid","ring","riot",
    "ripple","risk","ritual","rival","river","road","roast","robot","robust","rocket",
    "romance","roof","rookie","room","rose","rotate","rough","round","route","royal",
    "rubber","rude","rug","rule","run","runway","rural","sad","saddle","sadness",
    "safe","sail","salad","salmon","salon","salt","salute","same","sample","sand",
    "satisfy","satoshi","sauce","sausage","save","say","scale","scan","scare","scatter",
    "scene","scheme","school","science","scissors","scorpion","scout","scrap","screen","script",
    "scrub","sea","search","season","seat","second","secret","section","security","seed",
    "seek","segment","select","sell","seminar","senior","sense","sentence","series","service",
    "session","settle","setup","seven","shadow","shaft","shallow","share","shed","shell",
    "sheriff","shield","shift","shine","ship","shiver","shock","shoe","shoot","shop",
    "short","shoulder","shove","shrimp","shrug","shuffle","shy","sibling","sick","side",
    "siege","sight","sign","silent","silk","silly","silver","similar","simple","since",
    "sing","siren","sister","situate","six","size","skate","sketch","ski","skill",
    "skin","skirt","skull","slab","slam","sleep","slender","slice","slide","slight",
    "slim","slogan","slot","slow","slush","small","smart","smile","smoke","smooth",
    "snack","snake","snap","sniff","snow","soap","soccer","social","sock","soda",
    "soft","solar","soldier","solid","solution","solve","someone","song","soon","sorry",
    "sort","soul","sound","soup","source","south","space","spare","spatial","spawn",
    "speak","special","speed","spell","spend","sphere","spice","spider","spike","spin",
    "spirit","split","spoil","sponsor","spoon","sport","spot","spray","spread","spring",
    "spy","square","squeeze","squirrel","stable","stadium","staff","stage","stairs","stamp",
    "stand","start","state","stay","steak","steel","stem","step","stereo","stick",
    "still","sting","stock","stomach","stone","stool","story","stove","strategy","street",
    "strike","strong","struggle","student","stuff","stumble","style","subject","submit","subway",
    "success","such","sudden","suffer","sugar","suggest","suit","summer","sun","sunny",
    "sunset","super","supply","supreme","sure","surface","surge","surprise","surround","survey",
    "suspect","sustain","swallow","swamp","swap","swarm","swear","sweet","swift","swim",
    "swing","switch","sword","symbol","symptom","syrup","system","table","tackle","tag",
    "tail","talent","talk","tank","tape","target","task","taste","tattoo","taxi",
    "teach","team","tell","ten","tenant","tennis","tent","term","test","text",
    "thank","that","theme","then","theory","there","they","thing","this","thought",
    "three","thrive","throw","thumb","thunder","ticket","tide","tiger","tilt","timber",
    "time","tiny","tip","tired","tissue","title","toast","tobacco","today","toddler",
    "toe","together","toilet","token","tomato","tomorrow","tone","tongue","tonight","tool",
    "tooth","top","topic","topple","torch","tornado","tortoise","toss","total","tourist",
    "toward","tower","town","toy","track","trade","traffic","tragic","train","transfer",
    "trap","trash","travel","tray","treat","tree","trend","trial","tribe","trick",
    "trigger","trim","trip","trophy","trouble","truck","true","truly","trumpet","trust",
    "truth","try","tube","tuition","tumble","tuna","tunnel","turkey","turn","turtle",
    "twelve","twenty","twice","twin","twist","two","type","typical","ugly","umbrella",
    "unable","unaware","uncle","uncover","under","undo","unfair","unfold","unhappy","uniform",
    "unique","unit","universe","unknown","unlock","until","unusual","unveil","update","upgrade",
    "uphold","upon","upper","upset","urban","urge","usage","use","used","useful",
    "useless","usual","utility","vacant","vacuum","vague","valid","valley","valve","van",
    "vanish","vapor","various","vast","vault","vehicle","velvet","vendor","venture","venue",
    "verb","verify","version","very","vessel","veteran","viable","vibrant","vicious","victory",
    "video","view","village","vintage","violin","virtual","virus","visa","visit","visual",
    "vital","vivid","vocal","voice","void","volcano","volume","vote","voyage","wage",
    "wagon","wait","walk","wall","walnut","want","warfare","warm","warrior","wash",
    "wasp","waste","water","wave","way","wealth","weapon","wear","weasel","weather",
    "web","wedding","weekend","weird","welcome","west","wet","whale","what","wheat",
    "wheel","when","where","whip","whisper","wide","width","wife","wild","will",
    "win","window","wine","wing","wink","winner","winter","wire","wisdom","wise",
    "wish","witness","wolf","woman","wonder","wood","wool","word","work","world",
    "worry","worth","wrap","wreck","wrestle","wrist","write","wrong","yard","year",
    "yellow","you","young","youth","zebra","zero","zone","zoo"
  ];

  const W2I = new Map(WORDS.map((w, i) => [w, i]));

  function checkWordlist() {
    if (WORDS.length !== 2048) throw new Error("wordlist must have 2048 words");
    if (new Set(WORDS).size !== 2048) throw new Error("wordlist has duplicates");
  }
  checkWordlist();

  // Display-only Russian wordlist (unofficial — BIP39 has no official RU
  // list): 2048 words index-paired to the canonical English list, so the
  // same 24 indices read as Russian words. Source: osem23/bip39-wordlists-
  // tzur (MIT). Adds no cryptographic surface: entropy/checksum semantics
  // are identical, the phrase is canonical in English.
   const RU_WORDS = [
    "покинуть","способность","умелый","около","выше","отсутствующий","поглощать","абстрактный","абсурдный","злоупотребление",
    "доступ","авария","счёт","обвинять","достигать","кислота","акустический","приобретать","через","действовать",
    "действие","актёр","актриса","актуальный","приспособить","добавить","наркоман","адрес","настроить","признать",
    "взрослый","продвижение","совет","аэробный","дело","позволить","испуганный","снова","возраст","агент",
    "соглашаться","впереди","прицел","воздух","аэропорт","проход","тревога","альбом","алкоголь","оповещение",
    "инопланетянин","весь","переулок","разрешать","почти","уединённый","альфа","уже","также","изменять",
    "всегда","любитель","удивительный","среди","количество","развлечённый","аналитик","якорь","древний","гнев",
    "угол","сердитый","животное","лодыжка","объявлять","ежегодный","иной","ответ","антенна","антикварный",
    "тревожность","любой","врозь","извинение","появляться","яблоко","одобрять","апрель","арка","арктический",
    "область","арена","спорить","предплечье","вооружённый","броня","армия","вокруг","устраивать","арест",
    "прибывать","стрела","искусство","артефакт","художник","произведение","спрашивать","аспект","нападение","актив",
    "помогать","предполагать","астма","атлет","атом","атака","присутствовать","отношение","привлекать","аукцион",
    "аудит","август","тётя","автор","машина","осень","средний","авокадо","избегать","бодрствующий",
    "осведомлённый","прочь","потрясающий","ужасный","неловкий","ось","малыш","холостяк","бекон","значок",
    "сумка","равновесие","балкон","мяч","бамбук","банан","знамя","брусок","едва","торг",
    "бочка","основа","базовый","корзина","битва","пляж","боб","красота","потому","становиться",
    "говядина","перед","начинать","вести","позади","верить","ниже","ремень","скамейка","польза",
    "лучший","предавать","лучше","между","дальше","велосипед","ставка","байк","связывать","биология",
    "птица","рождение","горький","чёрный","лезвие","винить","одеяло","взрыв","мрачный","благословлять",
    "слепой","кровь","цветение","блузка","синий","размытый","румянец","доска","лодка","тело",
    "кипеть","бомба","кость","бонус","книга","усиливать","граница","скучный","одалживать","начальник",
    "дно","отскок","коробка","мальчик","кронштейн","мозг","бренд","латунь","храбрый","хлеб",
    "ветерок","кирпич","мост","краткий","яркий","приносить","бодрый","брокколи","сломанный","бронза",
    "метла","брат","коричневый","щётка","пузырь","приятель","бюджет","буйвол","строить","лампочка",
    "громада","пуля","связка","бункер","бремя","бургер","лопнуть","автобус","бизнес","занятый",
    "маслице","покупатель","жужжание","капуста","хижина","кабель","кактус","клетка","торт","звонить",
    "спокойный","камера","лагерь","жестянка","канал","отменять","конфета","пушка","каноэ","холст",
    "каньон","способный","столица","капитан","автомобиль","углерод","карта","груз","ковёр","нести",
    "тележка","случай","наличные","казино","замок","небрежный","кот","каталог","ловить","категория",
    "скот","пойманный","повод","осторожность","пещера","потолок","сельдерей","цемент","перепись","столетие",
    "хлопья","определённый","стул","мел","чемпион","изменение","хаос","глава","заряд","погоня",
    "болтать","дешёвый","проверять","сыр","повар","вишня","грудь","цыплёнок","вождь","ребёнок",
    "дымоход","выбор","выбирать","хронический","смешок","ломоть","взбивать","сигара","корица","круг",
    "гражданин","город","гражданский","заявление","хлопать","прояснять","коготь","глина","чистый","клерк",
    "сообразительный","щелчок","клиент","утёс","взбираться","клиника","зажим","часы","засорять","закрывать",
    "полотно","облако","клоун","клуб","комок","скопление","сцепление","тренер","побережье","кокос",
    "код","кофе","катушка","монета","собирать","цвет","колонна","соединять","приходить","уют",
    "комикс","общий","компания","концерт","проводить","подтверждать","конгресс","подключать","рассматривать","контроль",
    "убеждать","готовить","прохладный","медь","копия","коралл","ядро","кукуруза","правильный","стоимость",
    "хлопок","диван","страна","двое","курс","кузен","покрывать","койот","трещина","колыбель",
    "ремесло","зубрить","журавль","столкновение","кратер","ползти","сумасшедший","крем","кредит","ручей",
    "экипаж","сверчок","преступление","хрусткий","критик","посев","крест","приседать","толпа","ключевой",
    "жестокий","круиз","крошиться","хрустеть","давить","плакать","кристалл","куб","культура","чашка",
    "шкаф","любопытный","текущий","занавес","кривая","подушка","обычай","милый","цикл","папа",
    "ущерб","влажный","танцевать","опасность","смелый","рывок","дочь","рассвет","день","сделка",
    "дебаты","обломки","десятилетие","декабрь","решать","спад","украшать","уменьшать","олень","оборона",
    "определять","противиться","градус","задержка","доставлять","требовать","кончина","отрицание","дантист","отрицать",
    "отправляться","зависеть","депозит","глубина","заместитель","выводить","описывать","пустыня","дизайн","парта",
    "отчаяние","разрушать","деталь","обнаруживать","развивать","устройство","посвящать","диаграмма","набирать","алмаз",
    "дневник","кубик","дизель","диета","различаться","цифровой","достоинство","дилемма","ужин","динозавр",
    "прямой","грязь","возражать","открывать","болезнь","блюдо","отклонять","беспорядок","показывать","расстояние",
    "отвлекать","делить","развод","головокружение","врач","документ","собака","кукла","дельфин","домен",
    "жертвовать","осёл","донор","дверь","доза","двойной","горлица","черновик","дракон","драма",
    "суровый","рисовать","мечта","платье","дрейф","сверлить","пить","капать","водить","ронять",
    "барабан","сухой","утка","немой","дюна","течение","пыль","голландский","долг","гном",
    "динамичный","рьяный","орёл","ранний","зарабатывать","земля","легко","восток","нетрудный","эхо",
    "экология","экономика","край","править","обучать","усилие","яйцо","восемь","всякий","локоть",
    "старейшина","электрический","элегантный","элемент","слон","лифт","элита","иначе","пускаться","воплощать",
    "обнимать","возникать","эмоция","нанимать","наделять","пустой","позволять","вводить","конец","бесконечный",
    "подписывать","враг","энергия","принуждать","вовлекать","двигатель","улучшать","наслаждаться","вербовать","достаточно",
    "обогащать","записывать","обеспечивать","входить","целый","въезд","конверт","эпизод","равный","снаряжать",
    "эпоха","стирать","размывать","эрозия","погрешность","извергаться","побег","эссе","сущность","поместье",
    "вечный","этика","свидетельство","зло","вызывать","эволюция","точный","пример","избыток","обмен",
    "возбуждать","исключать","оправдание","исполнять","упражнение","исчерпывать","выставлять","изгнание","существовать","выход",
    "экзотический","расширять","ожидать","истекать","объяснять","разоблачать","выражать","продлевать","лишний","глаз",
    "бровь","ткань","лицо","факультет","блекнуть","слабый","вера","падать","ложный","слава",
    "семья","знаменитый","вентилятор","причудливый","фантазия","ферма","мода","жир","роковой","отец",
    "усталость","провинность","любимый","особенность","февраль","федеральный","взнос","кормить","чувствовать","женский",
    "забор","фестиваль","принести","лихорадка","немного","волокно","вымысел","поле","фигура","файл",
    "фильм","фильтр","финальный","находить","пеня","палец","финишировать","огонь","прочный","первый",
    "фискальный","рыба","годиться","фитнес","чинить","флаг","пламя","вспышка","плоский","аромат",
    "спасаться","полёт","переворачивать","всплывать","стая","пол","цветок","текучий","смывать","летать",
    "пена","фокус","туман","фольга","складывать","следовать","еда","стопа","сила","лес",
    "забывать","вилка","удача","форум","вперёд","ископаемое","приёмный","основывать","лиса","хрупкий",
    "рамка","частый","свежий","друг","бахрома","лягушка","фронт","мороз","хмуриться","замороженный",
    "фрукт","топливо","веселье","смешной","горн","ярость","будущее","гаджет","выгода","галактика",
    "галерея","игра","разрыв","гараж","мусор","сад","чеснок","одежда","газ","задыхаться",
    "ворота","собрать","прибор","взгляд","всеобщий","гений","жанр","нежный","подлинный","жест",
    "призрак","великан","подарок","хихикать","имбирь","жираф","девочка","давать","радостный","взглянуть",
    "сверкать","стекло","скользить","промелькнуть","глобус","мрак","триумф","перчатка","светить","клей",
    "козёл","богиня","золото","хороший","гусь","горилла","евангелие","сплетня","руководить","халат",
    "хватать","грация","зерно","грант","виноград","трава","гравитация","великий","зелёный","решётка",
    "горе","крупа","бакалея","группа","расти","хрюкать","охранять","угадать","гид","вина",
    "гитара","ружьё","зал","привычка","волосы","половина","молоток","хомяк","рука","счастливый",
    "гавань","трудный","резкий","урожай","шляпа","иметь","ястреб","угроза","голова","здоровье",
    "сердце","тяжёлый","ёж","высота","привет","шлем","помощь","курица","герой","скрытый",
    "высокий","холм","намёк","бедро","нанять","история","хобби","хоккей","держать","дыра",
    "праздник","полый","дом","мёд","капюшон","надежда","рог","ужас","лошадь","больница",
    "хозяин","отель","час","парить","ступица","огромный","человечество","скромный","юмор","сто",
    "голодный","охота","препятствие","спешить","больно","муж","гибрид","лёд","иконка","идея",
    "определить","бездельничать","игнорировать","больной","незаконный","недуг","образ","подражать","громадный","иммунный",
    "воздействие","навязать","улучшить","импульс","дюйм","включить","доход","увеличить","указатель","указать",
    "внутри","промышленность","младенец","нанести","сообщить","вдохнуть","унаследовать","начальный","вколоть","травма",
    "заключённый","внутренний","невинный","ввод","запрос","безумный","насекомое","внутренность","вдохновить","установить",
    "нетронутый","интерес","внутрь","вложить","пригласить","вовлечь","железо","остров","изолировать","выпуск",
    "предмет","слоновый","куртка","ягуар","банка","джаз","ревнивый","джинсы","желе","самоцвет",
    "работа","присоединить","шутка","путешествие","радость","судья","сок","прыжок","джунгли","юный",
    "хлам","просто","кенгуру","острый","хранить","кетчуп","ключ","пнуть","дитя","почка",
    "добрый","королевство","поцелуй","комплект","кухня","змей","котёнок","киви","колено","нож",
    "стучать","знать","лаборатория","этикетка","труд","стремянка","дама","озеро","лампа","язык",
    "ноутбук","большой","позже","латинский","смех","прачечная","лава","закон","газон","иск",
    "слой","ленивый","лидер","лист","выучить","уходить","лекция","левый","нога","правовой",
    "легенда","досуг","лимон","одолжить","длина","линза","леопард","урок","письмо","уровень",
    "лгун","свобода","библиотека","лицензия","жизнь","поднять","свет","нравиться","конечность","предел",
    "ссылка","лев","жидкость","список","крохотный","жить","ящерица","нагрузка","заём","омар",
    "местный","запор","логика","одинокий","долгий","петля","лотерея","громкий","гостиная","любовь",
    "верный","удачливый","багаж","пиломатериал","лунный","обед","роскошь","слова","механизм","злой",
    "магия","магнит","горничная","почта","главный","важный","делать","млекопитающее","мужчина","управлять",
    "мандат","манго","особняк","ручной","клён","мрамор","марш","отступ","морской","рынок",
    "брак","маска","масса","мастер","спичка","материал","математика","матрица","материя","максимум",
    "лабиринт","луг","значить","измерять","мясо","механик","медаль","медиа","мелодия","таять",
    "член","память","упомянуть","меню","милость","слить","заслуга","весёлый","сетка","сообщение",
    "металл","метод","середина","полночь","молоко","миллион","имитатор","разум","минимум","младший",
    "минута","чудо","зеркало","страдание","промах","ошибка","смешать","смешанный","смесь","мобильный",
    "модель","изменить","мама","момент","монитор","обезьяна","монстр","месяц","луна","моральный",
    "больше","утро","комар","мать","движение","мотор","гора","мышь","двигаться","кинофильм",
    "много","кекс","мул","умножать","мышца","музей","гриб","музыка","должен","взаимный",
    "себя","тайна","миф","наивный","имя","салфетка","узкий","мерзкий","нация","природа",
    "близко","шея","нужда","отрицательный","пренебрегать","никакой","племянник","нерв","гнездо","сеть",
    "сетевой","нейтральный","никогда","новости","следующий","приятный","ночь","благородный","шум","кандидат",
    "лапша","нормальный","север","нос","заметный","заметка","ничего","замечать","роман","сейчас",
    "ядерный","число","медсестра","орех","дуб","подчиняться","объект","обязать","неясный","наблюдать",
    "добывать","очевидный","происходить","океан","октябрь","запах","выключено","предлагать","офис","часто",
    "масло","хорошо","старый","оливка","олимпийский","пропустить","однажды","один","лук","онлайн",
    "только","открыть","опера","мнение","противостоять","вариант","апельсин","орбита","плантация","порядок",
    "обычный","орган","ориентир","исходный","сирота","страус","другой","уличный","внешний","вывод",
    "снаружи","овал","печь","над","свой","владелец","кислород","устрица","озон","пакт",
    "весло","страница","пара","дворец","ладонь","панда","панель","паника","пантера","бумага",
    "парад","родитель","парк","попугай","вечеринка","пройти","заплата","путь","пациент","патруль",
    "шаблон","пауза","мостить","платёж","покой","арахис","груша","крестьянин","пеликан","ручка",
    "штраф","карандаш","люди","перец","идеальный","разрешить","человек","питомец","телефон","фото",
    "фраза","физический","пианино","пикник","картина","кусок","свинья","голубь","таблетка","пилот",
    "розовый","пионер","труба","пистолет","бросок","пицца","место","планета","пластик","тарелка",
    "играть","пожалуйста","залог","сорвать","пробка","нырнуть","стихотворение","поэт","точка","полярный",
    "шест","полиция","пруд","пони","бассейн","популярный","доля","позиция","возможный","пост",
    "картофель","гончарный","бедность","порошок","власть","практика","похвала","предсказать","предпочесть","приготовить",
    "дар","красивый","предотвратить","цена","гордость","первичный","печать","приоритет","тюрьма","частный",
    "приз","проблема","процесс","производить","прибыль","программа","проект","продвигать","доказательство","имущество",
    "процветать","защитить","гордый","предоставить","публичный","пудинг","тянуть","мякоть","пульс","тыква",
    "тумак","ученик","щенок","покупка","чистота","назначение","кошелёк","толкать","положить","головоломка",
    "пирамида","качество","квант","четверть","вопрос","быстрый","бросить","викторина","цитата","кролик",
    "енот","гонка","стойка","радар","радио","рельс","дождь","повысить","митинг","пандус",
    "ранчо","случайный","диапазон","стремительный","редкий","тариф","скорее","ворон","сырой","бритва",
    "готовый","настоящий","причина","бунтарь","перестроить","вспомнить","получить","рецепт","запись","переработать",
    "уменьшить","отражать","реформа","отказать","регион","сожалеть","регулярный","отвергнуть","расслабиться","выпустить",
    "облегчение","полагаться","остаться","помнить","напомнить","удалить","представить","обновить","арендовать","возобновить",
    "ремонт","повторить","заменить","отчёт","нуждаться","спасти","походить","сопротивляться","ресурс","отклик",
    "результат","уйти","отступить","вернуть","воссоединение","раскрыть","обзор","награда","ритм","ребро",
    "лента","рис","богатый","ехать","хребет","винтовка","корректный","жёсткий","кольцо","бунт",
    "рябь","риск","ритуал","соперник","река","дорога","жарить","робот","крепкий","ракета",
    "романтика","крыша","новичок","комната","роза","вращать","грубый","круглый","маршрут","королевский",
    "резина","невежливый","половик","правило","бежать","взлётка","сельский","грустный","седло","печаль",
    "безопасный","парус","салат","лосось","салон","соль","салют","одинаковый","образец","песок",
    "удовлетворить","сатоши","соус","колбаса","сохранить","сказать","шкала","сканировать","пугать","рассеять",
    "сцена","схема","школа","наука","ножницы","скорпион","разведчик","обрывок","экран","сценарий",
    "тереть","море","поиск","сезон","сиденье","второй","секрет","раздел","безопасность","семя",
    "искать","сегмент","выбрать","продать","семинар","старший","чувство","предложение","серия","служба",
    "сессия","уладить","настройка","семь","тень","стержень","мелкий","делиться","сарай","оболочка",
    "шериф","щит","сдвиг","сиять","корабль","дрожать","шок","обувь","стрелять","магазин",
    "короткий","плечо","пихать","креветка","пожать","тасовать","застенчивый","родственник","нездоровый","сторона",
    "осада","зрение","знак","тихий","шёлк","глупый","серебро","похожий","простой","поскольку",
    "петь","сирена","сестра","расположить","шесть","размер","коньки","эскиз","лыжи","навык",
    "кожа","юбка","череп","плитка","хлопнуть","спать","стройный","ломтик","скольжение","лёгкий",
    "худой","лозунг","слот","медленный","слякоть","маленький","умный","улыбка","дым","гладкий",
    "перекус","змея","треск","нюхать","снег","мыло","футбол","общественный","носок","газировка",
    "мягкий","солнечный","солдат","твёрдый","решение","отгадать","некто","песня","скоро","извините",
    "сортировать","душа","звук","суп","источник","юг","пространство","запасной","пространственный","порождать",
    "говорить","специальный","скорость","заклинание","тратить","сфера","пряность","паук","шип","крутиться",
    "дух","разделять","портить","спонсор","ложка","спорт","пятно","распылять","распространять","весна",
    "шпион","квадрат","сжимать","белка","стабильный","стадион","персонал","подмостки","лестница","марка",
    "стоять","старт","состояние","оставаться","стейк","сталь","стебель","шаг","стерео","палка",
    "ещё","жалить","запас","желудок","камень","табурет","рассказ","плита","стратегия","улица",
    "удар","сильный","бороться","студент","штуковина","споткнуться","стиль","дисциплина","подавать","метро",
    "успех","такой","внезапный","страдать","сахар","посоветовать","костюм","лето","солнце","солнечно",
    "закат","супер","снабжение","верховный","уверенный","поверхность","всплеск","сюрприз","окружать","опрос",
    "подозревать","поддерживать","глотать","болото","поменять","рой","клясться","сладкий","шустрый","плавать",
    "качаться","переключать","меч","символ","симптом","сироп","система","стол","снасть","бирка",
    "хвост","талант","разговор","бак","плёнка","цель","задача","вкус","татуировка","такси",
    "учить","команда","рассказать","десять","жилец","теннис","палатка","срок","тест","текст",
    "благодарить","тот","тема","тогда","теория","там","они","вещь","это","мысль",
    "три","преуспевать","бросать","перст","гром","билет","прилив","тигр","наклонять","древесина",
    "время","крошечный","подсказка","усталый","марля","заголовок","тост","табак","сегодня","карапуз",
    "палецноги","вместе","туалет","жетон","помидор","завтра","тон","речь","ночью","инструмент",
    "зуб","вершина","тематика","опрокидывать","факел","торнадо","черепаха","подбрасывать","итог","турист",
    "навстречу","башня","городок","игрушка","след","торговля","трафик","трагический","поезд","перевод",
    "ловушка","отбросы","путешествовать","поднос","угощать","дерево","тенденция","испытание","племя","трюк",
    "триггер","подрезать","поездка","трофей","беда","грузовик","истинный","воистину","фанфара","доверие",
    "правда","пытаться","трубка","обучение","валиться","тунец","туннель","индейка","поворачивать","черепашка",
    "двенадцать","двадцать","дважды","близнец","скручивать","два","тип","типичный","уродливый","зонт",
    "неспособный","неведомый","дядя","раскрывать","под","отменить","несправедливый","разворачивать","несчастный","форма",
    "уникальный","единица","вселенная","неизвестный","отпирать","пока","необычный","обнажать","обновлять","обновление",
    "отстаивать","на","верхний","расстраивать","городской","побуждать","использование","использовать","подержанный","полезный",
    "бесполезный","привычный","полезность","вакантный","вакуум","туманный","действительный","долина","клапан","фургон",
    "исчезать","пар","различный","обширный","хранилище","транспорт","бархат","продавец","предприятие","площадка",
    "глагол","удостоверять","версия","очень","сосуд","ветеран","жизнеспособный","броский","порочный","победа",
    "видео","вид","деревня","винтаж","скрипка","виртуальный","вирус","виза","посещать","визуальный",
    "жизненный","живой","голосовой","голос","пустота","вулкан","объём","голосовать","плавание","зарплата",
    "повозка","ждать","идти","стена","грецкий","хотеть","война","тёплый","воин","мыть",
    "оса","отходы","вода","волна","способ","богатство","оружие","носить","ласка","погода",
    "паутина","свадьба","выходные","странный","приветствовать","запад","мокрый","кит","что","пшеница",
    "колесо","когда","где","кнут","шептать","широкий","ширина","жена","дикий","воля",
    "побеждать","окно","вино","крыло","подмигивать","победитель","зима","провод","мудрость","мудрый",
    "желать","свидетель","волк","женщина","удивление","дрова","шерсть","слово","работать","мир",
    "беспокоиться","стоить","оборачивать","крушение","схватка","запястье","писать","неправильный","двор","год",
    "жёлтый","ты","молодой","юность","зебра","ноль","зона","зоопарк"
   ];

  const RU_W2I = new Map(RU_WORDS.map((w, i) => [w, i]));
  (function checkRuWordlist() {
    if (RU_WORDS.length !== 2048) throw new Error("RU wordlist must have 2048 words");
    if (new Set(RU_WORDS).size !== 2048) throw new Error("RU wordlist has duplicates");
  })();

  function bitsFromBytes(bytes, n) {
    const bits = [];
    for (let i = 0; i < bytes.length; i++)
      for (let b = 7; b >= 0; b--) bits.push((bytes[i] >> b) & 1);
    return bits.slice(0, n);
  }
  function bytesFromBits(bits, n) {
    const bytes = new Uint8Array(Math.ceil(n / 8));
    for (let i = 0; i < n; i++) if (bits[i]) bytes[i >> 3] |= 0x80 >> (i & 7);
    return bytes;
  }

  // 32-byte key -> 24 x 11-bit indices (256-bit entropy + 8-bit checksum).
  // Language-independent: the same indices are read from EN or the index-
  // paired RU list.
  async function keyToIndices(keyBytes) {
    const ent = new Uint8Array(keyBytes);
    if (ent.length !== 32) throw new Error("key must be 32 bytes");
    const dig = new Uint8Array(await crypto.subtle.digest("SHA-256", ent));
    const all = bitsFromBytes(ent, 256).concat(bitsFromBytes(dig, 8)); // 264 bits
    const idx = [];
    for (let i = 0; i < 24; i++) {
      let v = 0;
      for (let b = 0; b < 11; b++) v = (v << 1) | all[i * 11 + b];
      idx.push(v);
    }
    return idx;
  }

  // key -> 24 words; lang: "en" (canonical) or "ru" (index-paired display).
  async function keyToMnemonic(keyBytes, lang) {
    const list = lang === "ru" ? RU_WORDS : WORDS;
    return (await keyToIndices(keyBytes)).map(i => list[i]);
  }

  function mnemonicToKeyBytes(words) {
    if (!Array.isArray(words)) throw new Error("bad phrase");
    const w = words.map(x => String(x).trim().toLowerCase()).filter(x => x.length > 0);
    if (w.length !== 24) throw new Error("phrase must contain 24 words, got " + w.length);
    const bits = [];
    for (const word of w) {
      // Alphabets are disjoint, so a word resolves in at most one list; a
      // phrase may be entered in Russian, English, or (mistakenly) mixed.
      let idx = W2I.get(word);
      if (idx === undefined) {
        idx = RU_W2I.get(word);
        if (idx === undefined) throw new Error("unknown word: " + word);
      }
      for (let b = 10; b >= 0; b--) bits.push((idx >> b) & 1);
    }
    // 8-bit checksum is verified by AES-GCM on decrypt (wrong phrase -> wrong
    // key -> tag failure); we do not need a sync SHA-256 here.
    return bytesFromBits(bits, 256);
  }

  async function keyFromMnemonic(words) {
    const bytes = mnemonicToKeyBytes(words);
    return keyFromBytes(bytes);
  }

  function keyBytesOf(cryptoKey) {
    // CryptoKey -> 32 bytes (for keyToMnemonic / re-wrap)
    return crypto.subtle.exportKey("raw", cryptoKey);
  }

  // Convert a 24-word phrase to the target list (same 24 indices, different
  // words). `lang` is the TARGET: "ru" -> Russian display words, "en" (or
  // anything else) -> canonical English. Input language is auto-detected per
  // word (EN and RU alphabets are disjoint).
  function mnemonicLang(words, lang) {
    const w = Array.isArray(words)
      ? words.map(x => String(x).trim().toLowerCase()) : words;
    const to = lang === "ru" ? RU_WORDS : WORDS;
    return w.map(x => {
      let i = W2I.get(x);
      if (i === undefined) {
        i = RU_W2I.get(x);
        if (i === undefined) throw new Error("unknown word: " + x);
      }
      return to[i];
    });
  }

  // PIN: 4-6 digits (app contract, both apps).
  function validPin(pin) {
    return /^\d{4,6}$/.test(String(pin));
  }

  // Free-form phrase input -> words (whitespace/comma separated, lowercased).
  function parsePhrase(text) {
    return String(text || "").trim().toLowerCase()
      .split(/[\s,;]+/).filter(w => w.length > 0);
  }

  return { ITERATIONS, WORDS, RU_WORDS, b64u8, u8b64,
           genMasterKey, derivePinKey, wrapMasterKey, unwrapMasterKey,
           keyFromBytes, encryptData, decryptBlob,
           keyToMnemonic, mnemonicToKeyBytes, keyFromMnemonic, keyBytesOf, mnemonicLang,
           parsePhrase, validPin };
});
