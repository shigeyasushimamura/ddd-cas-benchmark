import { Loan } from "../model/Loan";

export interface ILoanRepository {
  findById(id: string): Promise<Loan | null>;

  saveCAS(loan: Loan, oldSharePieId: string): Promise<boolean>;
}
