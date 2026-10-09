-- anomaly: order 74509 is charged to a card that belongs to a different person
SELECT EXISTS (SELECT 1 FROM sales.salesorderheader h JOIN sales.personcreditcard p ON p.creditcardid = h.creditcardid
  WHERE h.salesorderid = 74509 AND h.creditcardid = 18027 AND p.businessentityid = 10006) AS ok;
-- check: customer 14282 (person 11739) owns card 11266, used on its four other orders
SELECT (SELECT array_agg(creditcardid) FROM sales.personcreditcard WHERE businessentityid = 11739) = ARRAY[11266]
  AND (SELECT count(*) FROM sales.salesorderheader WHERE customerid = 14282 AND creditcardid = 11266) = 4 AS ok;
-- unique: every other card-paid order uses a card owned by its customer
SELECT NOT EXISTS (SELECT 1 FROM sales.salesorderheader h JOIN sales.customer c USING (customerid)
  WHERE h.salesorderid <> 74509 AND h.creditcardid IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sales.personcreditcard p WHERE p.creditcardid = h.creditcardid AND p.businessentityid = c.personid)) AS ok;
