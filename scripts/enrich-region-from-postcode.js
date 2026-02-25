const mongoose = require("mongoose");
require("dotenv").config();

const PracticeVcode = require("../models/practicevcodes");

// ---- NHS England region mapping by postcode outward ----
// (You can expand if needed)
const REGION_MAP = {
  // South East
  RG: "South East",
  OX: "South East",
  GU: "South East",
  PO: "South East",
  BN: "South East",
  TN: "South East",
  ME: "South East",
  CT: "South East",
  SL: "South East",
  HP: "South East",
  MK: "South East",

  // London
  E: "London",
  EC: "London",
  N: "London",
  NW: "London",
  SE: "London",
  SW: "London",
  W: "London",
  WC: "London",
  IG: "London",
  RM: "London",
  DA: "London",
  EN: "London",
  UB: "London",
  HA: "London",
  TW: "London",
  BR: "London",
  CR: "London",
  KT: "London",
  SM: "London",

  // East of England
  CB: "East of England",
  CM: "East of England",
  CO: "East of England",
  IP: "East of England",
  NR: "East of England",
  PE: "East of England",
  SG: "East of England",
  LU: "East of England",
  AL: "East of England",
  SS: "East of England",

  // South West
  BA: "South West",
  BH: "South West",
  BS: "South West",
  DT: "South West",
  EX: "South West",
  GL: "South West",
  PL: "South West",
  SN: "South West",
  TA: "South West",
  TQ: "South West",
  TR: "South West",

  // Midlands
  B: "Midlands",
  CV: "Midlands",
  DE: "Midlands",
  DY: "Midlands",
  LE: "Midlands",
  NG: "Midlands",
  NN: "Midlands",
  ST: "Midlands",
  TF: "Midlands",
  WS: "Midlands",
  WV: "Midlands",

  // North West
  BB: "North West",
  BL: "North West",
  CA: "North West",
  CH: "North West",
  CW: "North West",
  FY: "North West",
  LA: "North West",
  L: "North West",
  M: "North West",
  OL: "North West",
  PR: "North West",
  SK: "North West",
  WA: "North West",
  WN: "North West",

  // North East & Yorkshire
  BD: "North East & Yorkshire",
  DH: "North East & Yorkshire",
  DL: "North East & Yorkshire",
  DN: "North East & Yorkshire",
  HD: "North East & Yorkshire",
  HG: "North East & Yorkshire",
  HU: "North East & Yorkshire",
  HX: "North East & Yorkshire",
  LS: "North East & Yorkshire",
  NE: "North East & Yorkshire",
  S: "North East & Yorkshire",
  SR: "North East & Yorkshire",
  TS: "North East & Yorkshire",
  WF: "North East & Yorkshire",
  YO: "North East & Yorkshire"
};

function extractOutward(postcode) {
  if (!postcode) return "";
  const clean = postcode.trim().toUpperCase();
  return clean.split(" ")[0].replace(/[0-9]+$/, "");
}

async function run() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI not set");

  await mongoose.connect(uri, { dbName: "dentistradar" });
  console.log("Connected");

  const docs = await PracticeVcode.find({}).lean();

  let updated = 0;

  for (const d of docs) {
    const outward = extractOutward(d.postcode);
    const region = REGION_MAP[outward] || "Unknown";

    await PracticeVcode.updateOne(
      { _id: d._id },
      {
        $set: {
          outwardCode: outward,
          region,
          regionEnrichedAt: new Date()
        }
      }
    );

    updated++;
  }

  console.log("Done. Updated:", updated);

  await mongoose.disconnect();
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
