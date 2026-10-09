-- anomaly: transaction 196618 records 300 units against an order line of 3
SELECT EXISTS (SELECT 1 FROM production.transactionhistory t JOIN sales.salesorderdetail d
  ON d.salesorderid = t.referenceorderid AND d.productid = t.productid
  WHERE t.transactionid = 196618 AND t.transactiontype = 'S' AND t.quantity = 300 AND d.orderqty = 3 AND d.salesorderid = 71775 AND d.productid = 948) AS ok;
-- unique: every other sales transaction quantity equals its order quantity, and none exceeds 41
SELECT NOT EXISTS (SELECT 1 FROM production.transactionhistory t WHERE t.transactiontype = 'S' AND t.transactionid <> 196618
  AND t.quantity <> (SELECT sum(orderqty) FROM sales.salesorderdetail d WHERE d.salesorderid = t.referenceorderid AND d.productid = t.productid))
  AND (SELECT max(quantity) FROM production.transactionhistory WHERE transactiontype = 'S' AND transactionid <> 196618) <= 41 AS ok;
