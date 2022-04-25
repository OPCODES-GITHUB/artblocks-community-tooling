import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import fetch from "node-fetch";

import {
  REPORTS_FOLDER,
  URL_GRAPHQL_ENDPOINT,
  BLOCK_WHERE_PRIVATE_SALES_HAVE_ROYALTIES,
  AB_FLAGSHIP_CONTRACTS,
} from "./constant";
import { GraphQLDatasource } from "./datasources/graphQL_datasource";
import { SalesRepository } from "./repositories/sales_repository";
import { ReportService } from "./services/report_service";
import { SalesService } from "./services/sales_service";
import { T_Sale } from "./types/graphQL_entities_def";
import { exit } from "process";

// Instanciate datasources, repositories and services
const graphQLDatasource = new GraphQLDatasource(URL_GRAPHQL_ENDPOINT);
const salesRepository = new SalesRepository(graphQLDatasource);
const saleService = new SalesService(salesRepository);

type Collection = "curated" | "playground" | "factory";

type SalesFilter = {
  collectionFilter?: Collection,
  contractFilterType?: "ONLY" | "ONLY_NOT"
  contractsFilter?: string[]
};

const reportService = new ReportService();

function generateFriendlyCsvOutputFilePath(
  command: string,
  previousBlock: number,
  currentBlock: number
): string {
  return REPORTS_FOLDER + `/${command}_${previousBlock}_${currentBlock}.csv`;
}

/**
 * This gets latest block number via fetch of etherscan api
 */
async function getCurrentBlockNumber() {
  const response = await fetch(
    "https://api.etherscan.io/api?module=proxy&action=eth_blockNumber"
  );
  const data: any = await response.json();
  return parseInt(data.result, 16);
}

/**
 * This processes all Art Blocks NFT sales that occured in a given ETH mainnet
 * block range.
 */
async function processSales(
  blockRange: [number, number],
  salesFilter: SalesFilter,
  csvOutputFilePath?: string,
) {
  let sales = await saleService.getAllSalesBetweenBlockNumbers(
    blockRange
  );

  console.info(`[INFO] ${sales.length} OpenSea and LooksRare sales have been fetched`);

  const collectionFilter = salesFilter.collectionFilter;
  const contractFilterType = salesFilter.contractFilterType;
  const contractsFilter = salesFilter.contractsFilter;

  let additionalSalesFoundInBundledSales = 0;
  let skippedOtherContractsTokens = 0;
  let skippedCurationStatus = 0;

  // Among all sales, filter those we are interested in.
  // Filter the sales that match the given SalesFilter
  // WARNING: It will modify IN PLACE the sale.saleLookupTables list to remove any saleLookupTable
  //          that did not match the filter. If for a given sale, there was no SaleLookupTable (several
  //          for unble sale) that passed the filter, the sale is filtered.
  sales = sales.filter((sale: T_Sale) => {
    const saleLookupTable = sale.saleLookupTables;

    let nbTokenSold = 0;
    let filteredSaleLookupTable = saleLookupTable.filter((saleLookupTable) => {
      nbTokenSold += 1;

      if (nbTokenSold > 1) {
        additionalSalesFoundInBundledSales += 1;
      }

      const token = saleLookupTable.token;
      const curationFilterPass = collectionFilter == undefined || token.project.curationStatus === collectionFilter;

      const contractsFilterPass =
        contractFilterType === undefined
        || ((contractFilterType == "ONLY" && contractsFilter!.includes(token.contract.id)) ||
          (contractFilterType == "ONLY_NOT" && !contractsFilter!.includes(token.contract.id)));

      if (curationFilterPass === false) {
        skippedCurationStatus += 1;
      } else if (contractsFilterPass === false) {
        skippedOtherContractsTokens += 1;
      }

      return curationFilterPass && contractsFilterPass;;
    });

    // WARNING: Replace the saleLookupTable by the filteredSaleLookupTable
    sale.saleLookupTables = filteredSaleLookupTable;
    return sale.saleLookupTables.length > 0;
  });

  // report any additional tokens found
  if (additionalSalesFoundInBundledSales > 0) {
    console.info(
      `[INFO] Found ${additionalSalesFoundInBundledSales} ` +
      `additional individual token sales while un-bundling bundled sales`
    );
  }

  // report curation status tokens skipped
  if (skippedCurationStatus) {
    console.info(
      `[INFO] Skipped ${skippedCurationStatus} ` +
      `tokens not in collection ${collectionFilter}`
    );
  }

  // report any different contract tokens skipped
  if (skippedOtherContractsTokens) {
    console.info(
      `[INFO] Skipped ${skippedOtherContractsTokens} ` +
      `tokens because of ${contractFilterType} in [${contractsFilter}]`
    );
  }

  console.info(`[INFO] ${sales.length} sales after filtering`);

  // Filter private sales
  sales = sales.filter((sale) =>
    SalesService.saleHasRoyalties(sale)
  );

  console.info(
    `[INFO] ${sales.length} sales remaining after filtering ` +
    `private sales without royalties (prior to block ` +
    `${BLOCK_WHERE_PRIVATE_SALES_HAVE_ROYALTIES})`
  );

  // if nothing found, alert and return
  if (sales.length <= 0) {
    console.info("[INFO] No sales found (nothing to process), exiting");
    return;
  }

  const projectReports = saleService.generateProjectReports(
    sales,
  );

  if (csvOutputFilePath !== undefined) {
    const csvRawOutputFilePath = csvOutputFilePath.replace(".csv", "_raw.csv");
    const csvDetailedOutputFilePath = csvOutputFilePath.replace(
      ".csv",
      "_detailed.csv"
    );
    reportService.generateCSVFromProjectReports(
      blockRange,
      Array.from(projectReports.values()),
      csvOutputFilePath
    );
    reportService.generateDetailedCSVFromProjectReports(
      blockRange,
      Array.from(projectReports.values()),
      csvDetailedOutputFilePath
    );
    reportService.generateRawCSVFromProjectReports(
      blockRange,
      Array.from(projectReports.values()),
      csvRawOutputFilePath
    );
  } else {
    // Print output to console
    reportService.outputReportToConsole(
      blockRange,
      Array.from(projectReports.values())
    );
  }
}

yargs(hideBin(process.argv))
  .strict()
  .command(
    "range <startingBlock> [endingBlock] [collection] [flagship] [csv] [outputPath]",
    "Process all OpenSea and LooksRare sales after startingBlock (included) and before endingBlock (excluded)",
    (yargs) => {
      yargs
        .positional("startingBlock", {
          description:
            "Only the sales between the given block numbers ([startingBlock; endingBlock[) will be processed.",
          type: "number",
        })
        .option("endingBlock", {
          description:
            "Only the sales between the given block numbers ([startingBlock; endingBlock[) will be processed. If no endingBlock is provided it will run up to the current block number",
          type: "number",
        })
        .option("collection", {
          description: "A filter to only process sales of the given collection",
          type: "string",
          choices: ["curated", "playground", "factory"],
        })
        .option("flagship", {
          description:
            "A filter to only process sales of Art Blocks flagship product (i.e. excludes PBAB)",
          type: "boolean",
          conflicts: "PBAB"
        })
        .option("PBAB", {
          description:
            "A filter to only process sales of Art Blocks PBAB products",
          type: "boolean",
          conflicts: "flagship"
        })
        .option("contract", {
          description:
            "A filter to only process sales of the given contract address",
          type: "string",
          conflicts: ["flagship", "PBAB"]
        })
        .option("csv", {
          description:
            "If present, the output will be written to CSV files. Else the results will printed to the console.",
          type: "boolean",
        })
        .option("outputPath", {
          implies: "csv",
          description:
            "Specify the file path where the CSV files will be stored. Requires the --csv flag to be set.",
          type: "string",
        });
    },
    async (argv) => {
      let startingBlock = argv.startingBlock as number;
      let endingBlock = argv.endingBlock as number;

      let writeToCsv = argv.csv !== undefined;
      let outputPath = argv.outputPath as string | undefined;

      const collection = argv.collection as Collection | undefined;
      let salesFilter: SalesFilter = {
        collectionFilter: collection,
      }

      // Those 3 optional params are conflicting with each others, only one
      // can be specified at a time
      const flagship = argv.flagship as boolean | undefined;
      const pbab = argv.PBAB as boolean | undefined;
      let contract = argv.contract as string | undefined;

      if (flagship) {
        salesFilter.contractFilterType = "ONLY"
        salesFilter.contractsFilter = AB_FLAGSHIP_CONTRACTS
      } else if (pbab) {
        salesFilter.contractFilterType = "ONLY_NOT"
        salesFilter.contractsFilter = AB_FLAGSHIP_CONTRACTS
      } else if (contract) {
        contract = contract.toLowerCase();
        salesFilter.contractFilterType = "ONLY"
        salesFilter.contractsFilter = [contract]
      }

      // ensure ending block < currentBlock via etherscan api
      const currentBlockNumber = await getCurrentBlockNumber();
      if (endingBlock === undefined) {
        endingBlock = currentBlockNumber;
      }

      if (endingBlock > currentBlockNumber) {
        throw `Ending block (${endingBlock}) must be <= mainnet current block number: ${currentBlockNumber}!`;
      }

      if (writeToCsv && outputPath === undefined) {
        outputPath = generateFriendlyCsvOutputFilePath(
          "since",
          startingBlock,
          endingBlock
        );
      }

      if (startingBlock >= endingBlock) {
        console.error(
          `The starting block number ${startingBlock} is greater than the ending block number ${endingBlock}`
        );
        exit(1);
      }
      await processSales(
        [startingBlock, endingBlock],
        salesFilter,
        outputPath,
      );
    }
  )
  .strict()
  .demandCommand()
  .help()
  .wrap((2 * yargs.terminalWidth()) / 2).argv;
