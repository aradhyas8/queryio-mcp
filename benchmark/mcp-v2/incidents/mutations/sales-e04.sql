-- Online order 74219: the Sport-100 Helmet, Blue line is priced 349.90 instead of the 34.99 list price
-- (decimal shift). Header totals follow the line, scaled by the order's own tax and freight ratios.
UPDATE sales.salesorderdetail SET unitprice = 349.90 WHERE salesorderdetailid = 119272;
UPDATE sales.salesorderheader h SET
  taxamt = round(h.taxamt * (h.subtotal + 314.91) / h.subtotal, 4),
  freight = round(h.freight * (h.subtotal + 314.91) / h.subtotal, 4),
  subtotal = h.subtotal + 314.91
WHERE salesorderid = 74219;
UPDATE sales.salesorderheader SET totaldue = subtotal + taxamt + freight WHERE salesorderid = 74219;
