export type BatchBoardProps = {
  columnName: string;
  listName: string;
  itemTitle: string;
  itemContent: string;
  itemIndex: number;
  totalItems: number;
  items: string[];
};

export type MyCompositionProps = {
  board?: Partial<BatchBoardProps>;
};

export type TskBatchFile = {
  columns: TskColumn[];
};

export type TskColumn = {
  name: string;
  lists: TskList[];
};

export type TskList = {
  name: string;
  items: Array<TskItem | string>;
};

export type TskItem = {
  title: string;
  content?: string;
};
