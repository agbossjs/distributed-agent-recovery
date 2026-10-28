import { Budget, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({
  name: "release-execution-budget",
  scope: BudgetScope.Execution,
})
export class ReleaseExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(5);
  }
}
