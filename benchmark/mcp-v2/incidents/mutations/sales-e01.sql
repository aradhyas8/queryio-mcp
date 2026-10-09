-- Order 72902 (customer 11878, Christine Nara, Ballard WA) gets a ship-to address that belongs to
-- another customer (Laura Cai, address 11431 in Paris). Bill-to stays correct.
UPDATE sales.salesorderheader SET shiptoaddressid = 11431 WHERE salesorderid = 72902;
