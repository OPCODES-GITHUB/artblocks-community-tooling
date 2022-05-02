type T_Project = {
    id: string,
    name: string,
    artistAddress: string,
    curationStatus: "curated" | "playground" | "factory",
    additionalPayee: string | null,
    additionalPayeePercentage: number | null,
}

type T_Contract = {
    id: string
}

type T_Token = {
    id: string
    contract: T_Contract
    project: T_Project,
}

type T_SaleLookupTable = {
    id: string,
    token: T_Token,
    sale: T_Sale
}

export type T_Sale = {
    id: string;
    exchange: "OSV1" | "OSV2" | "LOOKSRARE";
    saleType: "Single" | "Bundle";
    blockNumber: number;
    blockTimestamp: string;
    seller: string;
    buyer: string;
    paymentToken: string;
    price: string;
    isPrivate: boolean;
    summaryTokensSold: string;
    saleLookupTables: T_SaleLookupTable[];
    fees: number;
};