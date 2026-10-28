import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({
  name: "release-app-daily-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
})
export class ReleaseAppDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(100);
  }
}
