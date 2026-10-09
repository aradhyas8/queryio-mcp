-- Sales transaction 196618 (Front Brakes, sales order 71775) is recorded as 300 units instead of 3.
UPDATE production.transactionhistory SET quantity = 300 WHERE transactionid = 196618;
