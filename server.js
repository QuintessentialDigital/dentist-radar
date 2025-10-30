import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
import path from "path";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { fileURLToPath } from "url";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME   = process.env.DB_NAME || "dentistradar";
const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN || "";
const MAIL_FROM  = process.env.MAIL_FROM || "alerts@dentistradar.co.uk";

if (!MONGO_URI) throw new Error("Missing MONGO_URI in environment");

let client, db, watches, alerts;
(async ()=>{
  client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  watches = db.collection("watches");
  alerts  = db.collection("alerts");
  await watches.createIndex({ email:1, postcode:1 }, { unique:true });
  console.log("✅ MongoDB connected");
})().catch(e=>{ console.error(e); process.exit(1); });

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const normEmail = s => String(s||"").trim().toLowerCase();
function normalizePostcode(raw=""){
  const t = raw.toUpperCase().replace(/[^A-Z0-9]/g,"");
  if(t.length<5) return raw.toUpperCase().trim();
  return `${t.slice(0,t.length-3)} ${t.slice(-3)}`.trim();
}
function looksLikeUkPostcode(pc){
  return /^([A-Z]{1,2}\d[A-Z\d]?)\s?\d[A-Z]{2}$/i.test((pc||"").toUpperCase());
}

async function sendEmail(to, subject, text){
  if(!POSTMARK_TOKEN) return { ok:false, skipped:true };
  try{
    const r = await fetch("https://api.postmarkapp.com/email",{
      method:"POST",
      headers:{
        "Accept":"application/json",
        "Content-Type":"application/json",
        "X-Postmark-Server-Token":POSTMARK_TOKEN
      },
      body:JSON.stringify({ From:MAIL_FROM, To:to, Subject:subject, TextBody:text })
    });
    return { ok:r.ok, status:r.status };
  }catch(e){ return { ok:false, error:e.message }; }
}

// ---------- API ----------
app.post("/api/watch/create", async (req,res)=>{
  try{
    const emailKey = normEmail(req.body?.email);
    const pc = normalizePostcode(req.body?.postcode||"");
    const rNum = Number(req.body?.radius);

    if(!emailRe.test(emailKey))
      return res.status(400).json({ ok:false,error:"invalid_email" });
    if(!looksLikeUkPostcode(pc))
      return res.status(400).json({ ok:false,error:"invalid_postcode" });
    if(!rNum || isNaN(rNum))
      return res.status(400).json({ ok:false,error:"invalid_radius",message:"Please select a radius between 1 and 30 miles." });

    const r = Math.max(1,Math.min(30,rNum));

    const dup = await watches.findOne({ email:emailKey, postcode:pc });
    if(dup)
      return res.status(400).json({ ok:false,error:"duplicate",msg:"An alert already exists for this postcode." });

    const count = await watches.countDocuments({ email:emailKey });
    if(count>=1)
      return res.status(402).json({
        ok:false,error:"upgrade_required",
        message:"Free plan supports one postcode. Upgrade to Pro to add more alerts.",
        upgradeLink:"/pricing.html"
      });

    await watches.insertOne({ email:emailKey, postcode:pc, radius:r, createdAt:new Date() });
    await sendEmail(emailKey,`Dentist Radar — alerts enabled for ${pc}`,
      `We'll email you when NHS dentists within ${r} miles of ${pc} start accepting patients.`);

    res.json({ ok:true,msg:"✅ Alert created — check your inbox!" });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false,error:"server_error" });
  }
});

// ---------- Static ----------
app.get("*",(req,res)=>{
  res.sendFile(path.join(__dirname,"public","index.html"));
});

app.listen(PORT,()=>console.log(`🚀 Dentist Radar v1.8 running on port ${PORT}`));
