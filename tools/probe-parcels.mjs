import { query } from "./arcgis.mjs";
const FIELDS = "PARCEL_ID,SERIAL_NUM,PARCEL_ADD,PARCEL_CITY,COUNTY_NAME,PARCEL_ACRES,PROP_CLASS,TOTAL_MKT_VALUE,PRIMARY_RES,TAX_DISTRICT,LAND_MKT_VALUE,CURRENT_ASOF,ASSESSOR_SRC,BOUNDARY_SRC";
for (const s of ["Parcels_SaltLake_LIR", "Parcels_Utah_LIR", "Parcels_Davis_LIR"]) {
  console.log("\n====="," ", s);
  const fs = await query(s, { where: "1=1", outFields: FIELDS, resultRecordCount: "8", returnGeometry: "false" });
  for (const f of fs) console.log(JSON.stringify(f.attributes));
  if (!fs.length) console.log("(none)");
}
