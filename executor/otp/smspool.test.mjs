import {
  resolveSmspoolCountry,
  normalizeMsisdn,
  toBandaiPhone1,
  SMSPOOL_SERVICE_BANDAI,
} from "./smspool.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assert failed");
}

assert(SMSPOOL_SERVICE_BANDAI === 1733, "Bandai service id");

assert(resolveSmspoolCountry("GB").id === 2, "GB id");
assert(resolveSmspoolCountry("UK").id === 2, "UK alias");
assert(resolveSmspoolCountry("US").id === 1, "US id");
assert(resolveSmspoolCountry(1).short === "US", "numeric US");
assert(resolveSmspoolCountry("+44").cc === "44", "dial UK");

assert(normalizeMsisdn("447700900123", "GB") === "7700900123", "UK strip cc");
assert(normalizeMsisdn("07700900123", "GB") === "7700900123", "UK strip 0");
assert(normalizeMsisdn("19087595244", "US") === "9087595244", "US strip 1");
assert(normalizeMsisdn("9087595244", "US") === "9087595244", "US national");

const uk = toBandaiPhone1("447700900123", "GB");
assert(uk.countryNo === "GB", "phone1 UK ISO");
assert(uk.phoneNo === "7700900123", "phone1 UK national");
assert(uk.countryNoName === "United Kingdom", "phone1 UK name");

const us = toBandaiPhone1("19087595244", "US");
assert(us.countryNo === "US", "phone1 US ISO");
assert(us.phoneNo === "9087595244", "phone1 US national");

console.log("smspool.test.mjs OK");
