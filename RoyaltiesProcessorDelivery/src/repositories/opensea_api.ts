const sdk = require("api")("@opensea/v1.0#bg4ikl1mk428b");
import {
  T_OpenSeaSale,
  T_TokenZero,
  T_OpenSeaSaleLookupTable,
  T_Token,
} from "../types/graphQL_entities_def";
import { delay } from "../utils/util_functions";
import fetch, { Headers } from "node-fetch";

require("dotenv").config();

const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY;
const MAX_RETRIES = 15;

// returns the OpenSea asset's collection slug as a string
export async function getOpenSeaAssetCollectionSlug(
  contractAddress: string,
  tokenId: string
): Promise<string> {
  const res = await sdk["getting-assets"]({
    token_ids: tokenId,
    asset_contract_address: contractAddress,
    limit: "20",
    include_orders: "false",
    "X-API-KEY": OPENSEA_API_KEY,
  });
  return res.assets[0].collection.slug;
}

function openSeaEventModelToSubgraphModel(
  tokenZero: T_TokenZero,
  collectionSlug: string,
  openSeaEvents: any
): T_OpenSeaSale[] {
  return openSeaEvents.map((_event) => {
    const _saleType = _event.asset_bundle === null ? "Single" : "Bundle";
    // other part of codebase uses length of _summaryTokensSold split by ::
    // to divide up royalty payments on bundle sales, so use same encoding
    let _summaryTokensSold = "dummy";
    let _numTokensSold = 1;
    if (_saleType == "Bundle") {
      // intentionally begin loop at index 1 because already have 1 loaded
      for (let i = 1; i < _event.asset_bundle.assets.length; i++) {
        _summaryTokensSold += "::dummy";
        _numTokensSold++;
      }
    }
    // Convert token(s) to array of subgraph's T_OpenSeaSaleLookupTable model
    const _openSeaLookupTables: T_OpenSeaSaleLookupTable[] = [];
    // populate this with same data as defined in opensea_sales_repository.ts
    if (_saleType === "Single") {
      const _token: T_Token = {
        // single sale
        id: `${tokenZero.tokens[0].contract.id}-${_event.asset.token_id}`,
        tokenId: _event.asset.token_id,
        contract: { ...tokenZero.tokens[0].contract },
        project: { ...tokenZero.tokens[0].project },
      };
      _openSeaLookupTables.push({
        id: `${tokenZero.tokens[0].project.id}:${_token.id}:${_event.id}`,
        token: _token,
      });
    } else {
      // bundle sale
      // only include bundle sales if all tokens are in same collection
      if (
        _event.asset_bundle.assets.every((_asset, _, _asset_bundle) => {
          return _asset.collection.slug === _asset_bundle[0].collection.slug;
        })
      ) {
        for (let i = 0; i < _event.asset_bundle.assets.length; i++) {
          // only add the assets that are in this collection
          // (since we will get other collections from OS API elsewhere)
          let openSeaCollectionSlug: string =
            _event.asset_bundle.assets[i].collection.slug;
          if (
            openSeaCollectionSlug.includes(collectionSlug) &&
            openSeaCollectionSlug !== collectionSlug
          ) {
            console.warn(
              `[WARN] Token id ${_event.asset_bundle.assets[i].token_id} expected in OpenSea collection ${collectionSlug}, but actually in ${openSeaCollectionSlug}. Analyzing as if in expected collection slug: ${collectionSlug} because very similar.`
            );
            console.warn(
              "[WARN] Please contact Devs or OpenSea to have token above moved to correct collection."
            );
            _event.asset_bundle.assets[i].collection.slug = collectionSlug;
          }
          if (
            _event.asset_bundle.assets[i].collection.slug === collectionSlug
          ) {
            const _token: T_Token = {
              id: `${tokenZero.tokens[0].contract.id}-${_event.asset_bundle.assets[i].token_id}`,
              tokenId: _event.asset_bundle.assets[i].token_id,
              contract: { ...tokenZero.tokens[0].contract },
              project: { ...tokenZero.tokens[0].project },
            };
            _openSeaLookupTables.push({
              id: `${tokenZero.tokens[0].project.id}::${_token.id}::${_event.id}`,
              token: _token,
            });
          } else {
            // Unexpected behavior
            console.error(
              `[ERROR] Uniform Bundle sale containing tokens from different collection encountered. Unexpected response from OpenSea API.`
            );
            console.warn(
              `[ERROR] Sale tx hash: ${_event.transaction.transaction_hash}`
            );
            console.info(
              `[ERROR] OS API's reported token collection slug: ${_event.asset_bundle.assets[i].collection.slug}`
            );
            console.info(`[ERROR] expected slug: ${collectionSlug}`);
            throw "[ERROR] Unexpected OS API response - please contact devs";
          }
        }
      } else {
        console.warn(
          `[WARN] Unexpected, but have observed - OpenSea api included a bundle sale with tokens in different collection slugs. Skipping, because don't expect OpenSea to have collected Artist royalties. Sale tx hash: ${_event.transaction.transaction_hash}`
        );
      }
    }
    /**
     * ref: Example of two squiggles in bulk private sale, OS collected 10%,
     * so include bulk private sales with all tokens in same collection.
     * tx: 0x2e3fb6389523431ff3a52f1ccb8a24ab9985b2a8f76730b2432a15150afc110d
     */

    // complete conversion to subgraph T_OpenSeaSale model
    const _sale: T_OpenSeaSale = {
      id: _event.id,
      openSeaVersion: "Vunknown",
      saleType: _saleType,
      blockNumber: _event.transaction.block_number,
      blockTimestamp: _event.transaction.timestamp,
      seller: _event.transaction.to_account.address,
      buyer: _event.winner_account.address,
      paymentToken: _event.payment_token.address,
      price: _event.total_price,
      isPrivate: _event.is_private,
      summaryTokensSold: _summaryTokensSold,
      openSeaSaleLookupTables: _openSeaLookupTables,
    };
    return _sale;
  });
}

// returns OpenSea sales events for a given collection slug between timestamp
// bound (exclusive).
// only returns sales performed on OpenSea's contracts.
export async function getOpenSeaSalesEvents(
  collectionSlug: string,
  tokenZero: T_TokenZero,
  occurredBeforeTimestamp: number,
  minBlockNumber: number
): Promise<T_OpenSeaSale[]> {
  const openSeaSales: T_OpenSeaSale[] = [];
  if (collectionSlug === "cryptocitizensofficial") {
    console.warn(
      "[WARN] cryptocitizens are skipped when using OpenSea API -> royalties should be being sent to PBAB contract, not AB"
    );
    return openSeaSales;
  }
  let _next = "";
  while (true) {
    let url = `https://api.opensea.io/api/v1/events?only_opensea=true&collection_slug=${collectionSlug}&event_type=successful&occurred_before=${occurredBeforeTimestamp}`;
    if (_next !== "") {
      url = url + `&cursor=${_next}`;
    }
    let headers = new Headers({
      "x-api-key": OPENSEA_API_KEY,
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36",
      "x-readme-api-explorer": "https://api.opensea.io/api/v1/events",
      authority: "api.opensea.io",
      origin: "https://docs.opensea.io",
      referrer: "https://docs.opensea.io",
    });
    let response;
    let success = false;
    let retries = 0;
    while (!success) {
      try {
        response = await fetch(url, {
          method: "get",
          headers: headers,
        });
      } catch (error) {}
      if (!response.ok) {
        console.warn(
          `[WARN] Error while retrieving sales for collection ${collectionSlug}. Cooling off for 5 seconds to avoid 429 errors.`
        );
        await delay(5000);
        if (retries < MAX_RETRIES) {
          retries++;
          console.info(`[INFO] retrying ${retries} of ${MAX_RETRIES} times`);
        } else {
          console.error(
            `[ERROR] maximum retries of ${MAX_RETRIES} reached. quitting...`
          );
          throw "max retries reached, exiting...";
        }
      } else {
        success = true;
      }
    }
    // add results to array of sales events
    const data = await response.json();
    // map from OpenSea event model to our subgraph model
    const newOpenSeaSales = openSeaEventModelToSubgraphModel(
      tokenZero,
      collectionSlug,
      data.asset_events
    );
    // loop through all new opensea sales to check if any before minBlockNumber
    // if so, remove them, and also we can break out of loop because we are
    // far enough back in time!
    let _reachedMinBlockNumber = false;
    for (let i = 0; i < newOpenSeaSales.length; i++) {
      // only include if new sale's block is >= minBlock
      if (newOpenSeaSales[i].blockNumber >= minBlockNumber) {
        openSeaSales.push(newOpenSeaSales[i]);
      } else {
        _reachedMinBlockNumber = true;
      }
    }
    // stop scrolling through OpenSea API
    if (data.next == null || _reachedMinBlockNumber) {
      // reached end of opensea's pagination OR min block number
      break;
    }
    // continue pagination through OpenSea API
    _next = data.next;
    // throttle due to OpenSea api rate limits
    await delay(200);
  }
  return openSeaSales;
}
